import { EXTRACTOR_PROMPT } from "@/lib/agent/prompts";
import { SUBMIT_EXTRACTION } from "@/lib/agent/tools";
import { runToolLoop, type AgentLoopResult } from "@/lib/agent/loop";
import { llmConfigured, modelFor } from "@/lib/agent/llm";

/** Matches submit_extraction's parameter schema in lib/agent/tools.ts exactly. */
export interface ExtractionSubmission {
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  po_reference: string | null;
  line_items: Array<{ description: string; quantity: number; unit_price: number }>;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  currency: string | null;
  confidence: number;
  uncertain_fields: string[];
}

export type ExtractionMethod =
  /** Deterministic template parse read every required field and the arithmetic reconciled. */
  | "template"
  /** The template parse was incomplete; an LLM read the document. */
  | "llm"
  /** Template parse was incomplete AND the LLM was unavailable/failed — partial result, low confidence. */
  | "template-incomplete";

export interface ExtractionResult extends AgentLoopResult<ExtractionSubmission> {
  method: ExtractionMethod;
  /** Why the LLM path was not used or did not work (set only for "template-incomplete"). */
  fallbackReason?: string;
}

/** Cap on stated confidence per method: a parse that reconciles is good evidence, never certainty. */
const CONFIDENCE_CAP: Record<ExtractionMethod, number> = { template: 0.95, llm: 0.9, "template-incomplete": 0.95 };
const CENT_TOLERANCE = 0.02;

// --- arithmetic + completeness checks (pure; the only source of the confidence we report) ---

export interface ExtractionAssessment {
  /** Every required field present and every arithmetic cross-check that could run passed. */
  complete: boolean;
  /** passed checks / checks that could run, 0-1. */
  checkScore: number;
  /** Human-readable names of what is missing or does not reconcile. */
  problems: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function assessExtraction(s: ExtractionSubmission): ExtractionAssessment {
  const checks: Array<{ ok: boolean; problem: string }> = [];
  const present = (v: string | null) => v != null && v.trim() !== "";

  checks.push({ ok: present(s.vendor_name), problem: "vendor_name missing" });
  checks.push({ ok: present(s.invoice_number), problem: "invoice_number missing" });
  checks.push({ ok: present(s.invoice_date), problem: "invoice_date missing or unreadable" });
  checks.push({
    ok: s.line_items.length > 0 && s.line_items.every((l) => l.description.trim() !== "" && l.quantity > 0 && l.unit_price >= 0),
    problem: "line_items missing or invalid (need a description, quantity > 0 and a price on every line)",
  });
  checks.push({ ok: s.total != null && s.total > 0, problem: "total missing" });

  const lineSum = round2(s.line_items.reduce((sum, l) => sum + l.quantity * l.unit_price, 0));
  if (s.line_items.length > 0) {
    if (s.subtotal != null) {
      checks.push({ ok: Math.abs(lineSum - s.subtotal) <= CENT_TOLERANCE, problem: `line items sum to ${lineSum.toFixed(2)} but subtotal says ${s.subtotal.toFixed(2)}` });
    }
    if (s.total != null) {
      const expected = round2((s.subtotal ?? lineSum) + (s.tax ?? 0));
      checks.push({ ok: Math.abs(expected - s.total) <= CENT_TOLERANCE, problem: `subtotal + tax is ${expected.toFixed(2)} but total says ${s.total.toFixed(2)}` });
    }
  }

  const failed = checks.filter((c) => !c.ok);
  return {
    complete: failed.length === 0,
    checkScore: checks.length === 0 ? 0 : (checks.length - failed.length) / checks.length,
    problems: failed.map((c) => c.problem),
  };
}

// --- deterministic template parser ---

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** ISO date out of "2026-09-10" or "Sep 10, 2026" / "10 September 2026". Slash dates are ambiguous (DD/MM vs MM/DD) so they return null rather than guess. */
export function normalizeDate(raw: string): string | null {
  const t = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const named = t.match(/^(?:(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})|([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4}))$/);
  if (!named) return null;
  const day = Number(named[1] ?? named[5]);
  const mon = MONTHS.indexOf((named[2] ?? named[4]).slice(0, 3).toLowerCase());
  const year = Number(named[3] ?? named[6]);
  if (mon < 0 || day < 1 || day > 31) return null;
  const iso = new Date(Date.UTC(year, mon, day));
  if (iso.getUTCMonth() !== mon) return null; // e.g. "Feb 31" rolled over
  return iso.toISOString().slice(0, 10);
}

function amountIn(text: string): number | null {
  const m = text.match(/(-?[\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function afterColon(line: string): string {
  return line.slice(line.indexOf(":") + 1).trim();
}

function detectCurrency(text: string): string | null {
  const explicit = text.match(/currency\s*:\s*([A-Za-z]{3})\b/i);
  if (explicit) return explicit[1].toUpperCase();
  if (/₹|\bINR\b/.test(text)) return "INR";
  if (/€|\bEUR\b/.test(text)) return "EUR";
  if (/£|\bGBP\b/.test(text)) return "GBP";
  if (/\bUSD\b|\$/.test(text)) return "USD";
  return null;
}

const RE = {
  invoiceNo: /^(?:invoice\s*(?:number|no\.?|#)|inv\s*(?:no\.?|#))\s*[:#]\s*(.+)$/i,
  date: /^(?:invoice\s*)?date\s*:\s*(.+)$/i,
  po: /^(?:purchase\s*order|po(?:\s*(?:number|no\.?|reference|ref\.?))?)\s*[:#]\s*(.+)$/i,
  subtotal: /^sub\s*-?\s*total\s*:/i,
  tax: /^(?:sales\s*)?(?:tax|vat|gst)\b[^:]*:/i,
  total: /^(?:grand\s*)?total(?:\s*amount)?(?:\s*due)?\s*:|^amount\s*due\s*:/i,
  lineStart: /^(\d+)\.\s*(.+)$/,
  lineInline: /^\d+\.\s*(.+?)\s*[-–—]\s*qty:?\s*(\d+(?:\.\d+)?)\s*[-–—]\s*unit\s*price:?\s*[$€£₹]?\s*([\d,]+(?:\.\d+)?)\s*$/i,
};

/**
 * Reads invoices laid out like the project's own templates (and the common "Invoice #:" /
 * "Qty: n / Unit Price: $x" shapes). Anything it cannot read is left null / empty — never
 * guessed — so assessExtraction() reports it and the LLM path takes over.
 */
export function parseTemplateInvoice(invoiceText: string): ExtractionSubmission {
  const lines = invoiceText.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const s: ExtractionSubmission = {
    vendor_name: null, invoice_number: null, invoice_date: null, po_reference: null,
    line_items: [], subtotal: null, tax: null, total: null, currency: null,
    confidence: 0, uncertain_fields: [],
  };

  let inLineItems = false;
  let current: { description?: string; quantity?: number; unit_price?: number } = {};
  const flush = () => {
    if (current.description && current.quantity != null && current.unit_price != null) {
      s.line_items.push({ description: current.description, quantity: current.quantity, unit_price: current.unit_price });
    }
    current = {};
  };

  for (const line of lines) {
    let m: RegExpMatchArray | null;
    if (/^line\s*items\s*:?$/i.test(line)) { inLineItems = true; continue; }
    if (inLineItems && (/^-{3,}$/.test(line) || RE.subtotal.test(line) || RE.total.test(line) || /^please make all checks/i.test(line))) {
      flush();
      inLineItems = false;
    }

    if (inLineItems) {
      if ((m = line.match(RE.lineInline))) {
        flush();
        s.line_items.push({ description: m[1].trim(), quantity: parseFloat(m[2]), unit_price: parseFloat(m[3].replace(/,/g, "")) });
      } else if ((m = line.match(RE.lineStart))) {
        flush();
        current = { description: m[2].trim() };
      } else if (/^qty\s*:/i.test(line)) {
        const q = line.match(/qty\s*:\s*(\d+(?:\.\d+)?)/i);
        if (q) current.quantity = parseFloat(q[1]);
      } else if (/^unit\s*price\s*:/i.test(line)) {
        const p = amountIn(afterColon(line));
        if (p != null) current.unit_price = p;
      }
      continue;
    }

    if ((m = line.match(RE.invoiceNo))) s.invoice_number = m[1].trim();
    else if ((m = line.match(RE.date))) s.invoice_date = normalizeDate(m[1]);
    else if ((m = line.match(RE.po))) s.po_reference = m[1].trim();
    else if (RE.subtotal.test(line)) s.subtotal = amountIn(afterColon(line));
    else if (RE.tax.test(line)) s.tax = amountIn(afterColon(line));
    else if (RE.total.test(line)) s.total = amountIn(afterColon(line));
  }
  flush();

  // The vendor is whatever heads the document, once the "INVOICE" title is skipped — a heuristic, reported as uncertain.
  const head = lines.find((l) => !/^(tax\s+)?invoice$/i.test(l) && !/:/.test(l));
  s.vendor_name = head ?? null;
  s.currency = detectCurrency(invoiceText);
  return s;
}

/** Fills in `confidence` and `uncertain_fields` on a submission from the checks — overriding whatever the producer claimed. */
function finalize(s: ExtractionSubmission, method: ExtractionMethod, selfReported?: number): ExtractionSubmission {
  const a = assessExtraction(s);
  const uncertain = [...a.problems];
  if (s.currency == null) {
    s.currency = "USD";
    uncertain.push("currency not stated — assumed USD");
  }
  if (method !== "llm" && s.vendor_name != null) uncertain.push("vendor_name taken from the document header (heuristic)");
  const cap = CONFIDENCE_CAP[method];
  const base = a.checkScore * cap;
  return { ...s, confidence: Math.round(Math.min(base, selfReported ?? 1) * 100) / 100, uncertain_fields: uncertain };
}

/**
 * Extraction, honestly labelled. Order of attempts:
 *   1. Deterministic template parse. If it reads every required field AND the numbers reconcile
 *      (lines sum to subtotal, subtotal + tax = total), that is the answer — no LLM call.
 *   2. Otherwise an LLM reads the document (single-turn forced tool call), and the SAME
 *      arithmetic checks are applied to what it returned. Its self-reported confidence can
 *      only lower the score, never raise it.
 *   3. If the LLM is unavailable or fails, return the partial template parse at low confidence
 *      with `fallbackReason` set — the pipeline then raises EXC-LAYOUT for a human instead of
 *      pretending the document was read.
 */
export async function extract(invoiceText: string): Promise<ExtractionResult> {
  const parsed = parseTemplateInvoice(invoiceText);
  if (assessExtraction(parsed).complete) {
    return { submission: finalize(parsed, "template"), toolCalls: [], turns: 1, model: "template-parser", method: "template" };
  }

  const incomplete = (reason: string): ExtractionResult => ({
    submission: finalize(parsed, "template-incomplete"), toolCalls: [], turns: 1, model: "template-parser", method: "template-incomplete", fallbackReason: reason,
  });

  if (!llmConfigured()) return incomplete("template parse was incomplete and no LLM is configured (GROQ_API_KEY not set)");

  try {
    const llm = await runToolLoop<ExtractionSubmission>({
      role: "extractor",
      instructions: EXTRACTOR_PROMPT,
      initialInput: invoiceText,
      tools: [SUBMIT_EXTRACTION],
      submissionToolName: "submit_extraction",
      executeTool: async (name) => {
        throw new Error(`extract(): unexpected tool call '${name}' — the Extractor has no evidence tools`);
      },
      maxTurns: 2,
    });
    const sub = llm.submission;
    sub.line_items = Array.isArray(sub.line_items) ? sub.line_items : [];
    return { ...llm, submission: finalize(sub, "llm", typeof sub.confidence === "number" ? sub.confidence : undefined), method: "llm" };
  } catch (e) {
    // Not swallowed: the reason travels with the result into the ledger claim and the API response.
    return incomplete(`LLM extraction (${modelFor("extractor")}) failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
