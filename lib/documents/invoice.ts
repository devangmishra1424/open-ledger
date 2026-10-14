import type { ExtractionMethod, ExtractionResult, ExtractionSubmission } from "@/lib/agent/extractor";
import { llmConfigured, modelFor } from "@/lib/agent/llm";
import { runToolLoop } from "@/lib/agent/loop";
import { DOCUMENT_READER_PROMPT } from "@/lib/agent/prompts";
import { SUBMIT_INVOICE_READING } from "@/lib/documents/ai-reader-tool";
import { amountPrintedIn, DATE_TOKEN, dateOrderFor, parseDate } from "@/lib/documents/formats";
import { documentText, rowsFromReading } from "@/lib/documents/layout";
import { readInvoiceRules, type RuleReading } from "@/lib/documents/invoice-rules";
import type { Reading } from "@/lib/documents/reader-client";

/**
 * An invoice's fields from a document reading, and how far to trust each one.
 *
 *  1. Layout rules (lib/documents/invoice-rules.ts) read every field they can. No AI.
 *  2. The reading is checked: required fields present, every item row's arithmetic, items add up to the
 *     subtotal, subtotal + taxes + charges - discount + round off = total.
 *  3. Only if something is missing or does not add up, an AI model reads the same text. Every value it returns
 *     must be printed in the document (numbers, identifiers, dates, the vendor's name); a value that is not is
 *     refused, so the AI can fill a gap but cannot invent one. The checks then run again.
 *  4. Confidence = the share of checks passed, capped by method (rules 0.95, AI 0.9) and, for a scan or photo,
 *     by the OCR's own confidence. Under REVIEW_THRESHOLD a person must check it before anything is paid; every
 *     field that is unsure says why in `uncertain_fields`.
 */

export const REVIEW_THRESHOLD = 0.85;
/** An OCR'd value below this confidence is named as uncertain even when everything adds up. */
const FIELD_OCR_FLOOR = 0.9;
const CAP: Record<ExtractionMethod, number> = { template: 0.95, llm: 0.9, "template-incomplete": 0.95 };
const MAX_AI_CHARS = 16_000;

export type FieldSource = "rules" | "ai" | "rules+ai";

export interface InvoiceExtraction extends ExtractionResult {
  /** Who read each field: the layout rules, the AI (only where the rules could not), or both agreeing. */
  fieldSources: Record<string, FieldSource>;
  /** The arithmetic and completeness checks, each passed or failed, in plain words. */
  checks: Array<{ check: string; passed: boolean }>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.011, Math.abs(b) * 0.0002);
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

interface Assessment { checks: Array<{ check: string; passed: boolean }>; problems: string[] }

/** The checks that decide confidence. Pure. */
export function assessInvoice(s: ExtractionSubmission): Assessment {
  const checks: Array<{ check: string; passed: boolean }> = [];
  const problems: string[] = [];
  const add = (check: string, passed: boolean, problem: string) => {
    checks.push({ check, passed });
    if (!passed) problems.push(problem);
  };
  const present = (v: string | null | undefined) => v != null && v.trim() !== "";

  add("vendor named", present(s.vendor_name), "vendor_name missing");
  add("invoice number read", present(s.invoice_number), "invoice_number missing");
  add("invoice date read", present(s.invoice_date), "invoice_date missing or unreadable");
  add("total read", s.total != null && s.total > 0, "total missing");
  const linesOk = s.line_items.length > 0 && s.line_items.every((l) => l.description.trim() !== "" && l.quantity > 0 && l.unit_price >= 0);
  add("item lines read", linesOk, "line_items missing or invalid (need a description, quantity > 0 and a price on every line)");

  if (s.line_items.length > 0) {
    // VeriBook books each line as quantity x unit price, so that must be the line's amount. This catches a reading
    // that pairs a printed list price with a printed discounted amount: both numbers are on the page, the amounts
    // still add up, yet the line would be booked at the undiscounted price.
    const offLines = s.line_items.filter((l) => l.amount != null && !close(round2(l.quantity * l.unit_price), l.amount));
    add("each line: quantity x price = amount", offLines.length === 0,
      `line_items: ${offLines.map((l) => `"${l.description.slice(0, 30)}" ${l.quantity} x ${l.unit_price} is not its amount ${l.amount}`).join("; ")}`);
    const lineSum = round2(s.line_items.reduce((sum, l) => sum + (l.amount ?? l.quantity * l.unit_price), 0));
    if (s.subtotal != null) {
      add("items add up to the subtotal", close(lineSum, s.subtotal), `line_items sum to ${lineSum.toFixed(2)} but the subtotal says ${s.subtotal.toFixed(2)}`);
    }
    if (s.total != null) {
      const charges = round2((s.other_charges ?? []).reduce((sum, c) => sum + c.amount, 0));
      const expected = round2((s.subtotal ?? lineSum) + (s.tax ?? 0) + charges - (s.discount ?? 0) + (s.round_off ?? 0));
      const parts = [`subtotal ${(s.subtotal ?? lineSum).toFixed(2)}`, `tax ${(s.tax ?? 0).toFixed(2)}`];
      if (charges) parts.push(`charges ${charges.toFixed(2)}`);
      if (s.discount) parts.push(`less discount ${s.discount.toFixed(2)}`);
      if (s.round_off) parts.push(`round off ${s.round_off.toFixed(2)}`);
      add("subtotal + taxes + charges = total", close(expected, s.total), `total: ${parts.join(" + ")} = ${expected.toFixed(2)} but the total says ${s.total.toFixed(2)}`);
    }
  }
  return { checks, problems };
}

function fromRules(r: RuleReading): ExtractionSubmission {
  return {
    vendor_name: r.vendor_name, vendor_tax_id: r.vendor_tax_id, invoice_number: r.invoice_number, invoice_date: r.invoice_date,
    due_date: r.due_date, po_reference: r.po_reference, currency: r.currency,
    line_items: r.line_items.map((l) => ({ description: l.description, quantity: l.quantity, unit_price: l.unit_price, uom: l.uom, amount: l.amount })),
    subtotal: r.subtotal, tax: r.tax, tax_lines: r.tax_lines, other_charges: r.other_charges, discount: r.discount, round_off: r.round_off,
    total: r.total, confidence: 0, uncertain_fields: [],
  };
}

// ------------------------------------------------------------------------------------------------ AI, grounded

interface AiReading {
  vendor_name: string | null; vendor_tax_id: string | null; invoice_number: string | null; invoice_date: string | null; due_date: string | null;
  po_reference: string | null; currency: string | null;
  line_items: Array<{ description: string; quantity: number; unit_price: number; amount: number | null }>;
  subtotal: number | null; tax_lines: Array<{ label: string; amount: number }>; other_charges: Array<{ label: string; amount: number }>;
  discount: number | null; round_off: number | null; total: number | null; uncertain_fields: string[];
}

/** Whether a value the AI returned is actually printed in the document. */
function grounded(field: string, value: unknown, text: string, squashed: string, order: ReturnType<typeof dateOrderFor>): boolean {
  if (value == null) return false;
  if (typeof value === "number") return amountPrintedIn(value, text);
  const v = String(value);
  if (field === "invoice_date" || field === "due_date") {
    return [...text.matchAll(DATE_TOKEN)].some((m) => parseDate(m[0], order)?.iso === v);
  }
  if (field === "vendor_name") {
    const words = v.toLowerCase().split(/[^a-z0-9&]+/).filter((w) => w.length > 1);
    return words.length > 0 && words.filter((w) => text.toLowerCase().includes(w)).length / words.length >= 0.75;
  }
  if (field === "currency") return true; // a code, not printed text; currency evidence is checked by detectCurrency
  return squash(v).length > 0 && squashed.includes(squash(v));
}

function lineGrounded(l: AiReading["line_items"][number], text: string): boolean {
  return amountPrintedIn(l.quantity, text) && (amountPrintedIn(l.unit_price, text) || (l.amount != null && amountPrintedIn(l.amount, text)));
}

async function aiRead(text: string): Promise<{ reading: AiReading; model: string; toolCalls: ExtractionResult["toolCalls"]; turns: number }> {
  const result = await runToolLoop<AiReading>({
    role: "extractor",
    instructions: DOCUMENT_READER_PROMPT,
    initialInput: text.length > MAX_AI_CHARS ? `${text.slice(0, MAX_AI_CHARS)}\n[... document truncated ...]` : text,
    tools: [SUBMIT_INVOICE_READING],
    submissionToolName: "submit_invoice_reading",
    executeTool: async (name) => {
      throw new Error(`extractInvoice: unexpected tool call '${name}' — the document reader has no evidence tools`);
    },
    maxTurns: 2,
  });
  const r = result.submission;
  r.line_items = Array.isArray(r.line_items) ? r.line_items : [];
  r.tax_lines = Array.isArray(r.tax_lines) ? r.tax_lines : [];
  r.other_charges = Array.isArray(r.other_charges) ? r.other_charges : [];
  return { reading: r, model: result.model, toolCalls: result.toolCalls, turns: result.turns };
}

// ------------------------------------------------------------------------------------------------ the whole read

export async function extractInvoice(reading: Reading, opts: { llm?: boolean } = {}): Promise<InvoiceExtraction> {
  const rows = rowsFromReading(reading);
  const text = documentText(rows);
  const squashed = squash(text);
  const rules = readInvoiceRules(rows);
  const s = fromRules(rules);
  if (s.subtotal == null && s.line_items.length > 0 && rules.line_items.every((l) => !l.problem)) {
    s.subtotal = round2(s.line_items.reduce((sum, l) => sum + (l.amount ?? l.quantity * l.unit_price), 0)); // not printed: the items' sum
  }
  const sources: Record<string, FieldSource> = {};
  for (const [k, v] of Object.entries(s)) if (v != null && !(Array.isArray(v) && v.length === 0)) sources[k] = "rules";

  let assessment = assessInvoice(s);
  const ruleProblems = rules.problems.filter((p) => p.startsWith("line_items: line"));
  let method: ExtractionMethod = "template";
  let model = "layout-rules";
  let toolCalls: ExtractionResult["toolCalls"] = [];
  let turns = 1;
  let fallbackReason: string | undefined;
  const refused: string[] = [];

  const needsHelp = assessment.problems.length > 0 || ruleProblems.length > 0;
  if (needsHelp && opts.llm !== false) {
    if (!llmConfigured()) {
      method = "template-incomplete";
      fallbackReason = "the layout rules could not read everything and no AI model is configured (GROQ_API_KEY not set)";
    } else {
      try {
        const ai = await aiRead(reading.layout_text || reading.markdown);
        model = ai.model;
        toolCalls = ai.toolCalls;
        turns = ai.turns;
        method = "llm";
        mergeAi(s, ai.reading, sources, refused, text, squashed, rules, assessment);
        assessment = assessInvoice(s);
      } catch (e) {
        // Not swallowed: the reason travels with the result into the ledger claim and the API response.
        method = "template-incomplete";
        fallbackReason = `the AI reader (${modelFor("extractor")}) failed: ${e instanceof Error ? e.message : String(e)}`;
        console.error(`extractInvoice: ${reading.filename}: ${fallbackReason}`);
      }
    }
  } else if (needsHelp) {
    method = "template-incomplete";
    fallbackReason = "the layout rules could not read everything (AI reading was not requested)";
  }

  // ---- confidence and what a person should check
  const uncertain = [...assessment.problems];
  if (method !== "llm") uncertain.push(...ruleProblems.filter((p) => !uncertain.includes(p)));
  uncertain.push(...refused);
  if (s.currency == null) uncertain.push("currency: not stated on the document");
  if (rules.date_ambiguous && sources.invoice_date === "rules") uncertain.push("invoice_date: written all in numbers and could be day/month either way");
  if (sources.vendor_name === "rules" && !rules.vendor_corroborated) {
    uncertain.push(rules.vendor_from === "letterhead"
      ? "vendor_name: taken from the letterhead, and nothing else on the document confirms it"
      : "vendor_name: read by OCR and printed only once, so check its spelling");
  }
  if (reading.ocr_used) {
    for (const [field, conf] of Object.entries(rules.field_conf)) {
      if (conf != null && conf < FIELD_OCR_FLOOR && sources[field] === "rules") uncertain.push(`${field}: the OCR was unsure of this text (${conf.toFixed(2)})`);
    }
    for (const l of rules.line_items) {
      if (l.conf != null && l.conf < FIELD_OCR_FLOOR && sources.line_items === "rules") uncertain.push(`line_items: the OCR was unsure of the line "${l.description.slice(0, 40)}" (${l.conf.toFixed(2)})`);
    }
  }
  for (const w of reading.warnings) uncertain.push(`document: ${w}`);

  const passed = assessment.checks.filter((c) => c.passed).length;
  let confidence = (assessment.checks.length ? passed / assessment.checks.length : 0) * CAP[method];
  if (reading.ocr_used) confidence = Math.min(confidence, reading.ocr_confidence ?? 0.8);
  if (uncertain.length > 0) confidence = Math.min(confidence, REVIEW_THRESHOLD - 0.01);
  s.confidence = Math.round(confidence * 100) / 100;
  s.uncertain_fields = [...new Set(uncertain)];

  return { submission: s, method, model, toolCalls, turns, fallbackReason, fieldSources: sources, checks: assessment.checks };
}

/** Fills what the rules could not read with what the AI read, keeping only values printed in the document. */
function mergeAi(
  s: ExtractionSubmission, ai: AiReading, sources: Record<string, FieldSource>, refused: string[], text: string, squashed: string,
  rules: RuleReading, assessment: Assessment,
): void {
  const order = dateOrderFor(ai.currency ?? s.currency, text);
  const failed = (field: string) => assessment.problems.some((p) => p.startsWith(field)) || rules.problems.some((p) => p.startsWith(field));

  for (const field of ["vendor_name", "vendor_tax_id", "invoice_number", "invoice_date", "due_date", "po_reference", "currency"] as const) {
    const mine = s[field] ?? null;
    const theirs = ai[field] ?? null;
    if (theirs == null || theirs === "") continue;
    if (mine != null && squash(String(mine)) === squash(String(theirs))) {
      sources[field] = "rules+ai";
      continue;
    }
    if (mine != null && !failed(field)) continue; // the rules read it and nothing says they were wrong: keep it
    if (!grounded(field, theirs, text, squashed, order)) {
      refused.push(`${field}: the AI suggested "${theirs}", which is not printed in the document, so it was not used`);
      continue;
    }
    (s as unknown as Record<string, unknown>)[field] = theirs;
    sources[field] = "ai";
  }

  // Item lines: the AI's lines replace the rules' only when the rules' lines failed and every AI line is printed.
  const ruleLinesBad = s.line_items.length === 0 || rules.line_items.some((l) => l.problem) || failed("line_items");
  if (ruleLinesBad && ai.line_items.length > 0) {
    if (ai.line_items.every((l) => lineGrounded(l, text))) {
      s.line_items = ai.line_items.map((l) => ({ description: l.description, quantity: l.quantity, unit_price: l.unit_price, amount: l.amount ?? round2(l.quantity * l.unit_price) }));
      sources.line_items = "ai";
    } else {
      refused.push("line_items: the AI's item lines include numbers that are not printed in the document, so they were not used");
    }
  }

  // Money: take the AI's figure only for a figure the rules lacked or that does not add up, and only if printed.
  const money: Array<[keyof ExtractionSubmission, number | null]> = [["subtotal", ai.subtotal], ["total", ai.total], ["discount", ai.discount], ["round_off", ai.round_off]];
  for (const [field, value] of money) {
    if (value == null) continue;
    const mine = s[field] as number | null | undefined;
    if (mine != null && close(mine, value)) { sources[field] = "rules+ai"; continue; }
    if (mine != null && !assessment.problems.some((p) => p.startsWith("total") || p.startsWith("line_items sum"))) continue;
    if (!amountPrintedIn(Math.abs(value), text)) { refused.push(`${String(field)}: the AI suggested ${value}, which is not printed in the document`); continue; }
    (s as unknown as Record<string, unknown>)[field] = value;
    sources[field] = "ai";
  }
  const aiTax = ai.tax_lines.filter((t) => amountPrintedIn(t.amount, text));
  if (aiTax.length > 0 && (s.tax_lines ?? []).length === 0) {
    s.tax_lines = aiTax;
    s.tax = round2(aiTax.reduce((sum, t) => sum + t.amount, 0));
    sources.tax = "ai";
  } else if (aiTax.length > 0 && s.tax != null && close(round2(aiTax.reduce((sum, t) => sum + t.amount, 0)), s.tax)) {
    sources.tax = "rules+ai";
  }
  const aiCharges = ai.other_charges.filter((c) => amountPrintedIn(c.amount, text));
  if (aiCharges.length > 0 && (s.other_charges ?? []).length === 0) {
    s.other_charges = aiCharges;
    sources.other_charges = "ai";
  }
}
