import type { Action } from "@/lib/matching/decision-matrix";
import * as facts from "@/lib/matching/finding-facts";
import { descriptionSimilarity } from "@/lib/matching/line-match";
import { isPlausibleUomConversion } from "@/lib/matching/uom-dimension";
import type { ThreeWay } from "@/lib/three-way";
import type { FactPoint, FactShown } from "@/lib/types";

/**
 * What does not match on one invoice, for a person: each finding as a plain title and its figures side by side
 * (what the invoice says, what the order, the delivery or your records say, and the gap, marked as wrong).
 *
 * The figures come from the match step's own record (`shown`, recorded since 2026-10-17), so they are the numbers
 * the engine decided on. A record made before that has only the sentence: its figures are worked out here from the
 * purchase-order comparison (lib/three-way.ts, the same pairing the engine matched from) and say so
 * (`source: "worked_out"`). Where neither is possible the sentence is shown on its own. Findings the engine let
 * through on their own (auto_approve, e.g. a partial delivery) are not problems and are left out.
 *
 * Pure: everything is passed in, so it is tested without a database.
 */

export interface MismatchView {
  /** The reason code, e.g. EXC-PRICE_VAR. */
  code: string;
  title: string;
  points: FactPoint[];
  /** The recorded sentence, when there is one. */
  text: string | null;
  /** "recorded": the engine's own figures; "worked_out": from today's order comparison, for an older record. */
  source: "recorded" | "worked_out";
}

export interface MismatchInput {
  /** The live match decision: its claims and, aligned with them, any recorded figures. */
  match?: { claims: string[]; shown?: Array<FactShown | null> };
  /** The live validate decision's claims ("duplicate: failed - ..."). */
  validate?: { claims: string[] };
  threeWay?: ThreeWay | null;
  bill: { amount: number; currency: string; invoiceDate: string; poReference: string | null; hasPo: boolean };
  vendorTrustTier?: string | null;
  bankChange?: { status: string; oldBankLast4: string | null; newBankLast4: string | null } | null;
}

const FINDING_LINE = /^(EXC-[A-Z_]+|R99_AGENT_ERROR|CLEAN_MATCH|POLICY_LIMIT|INVESTIGATOR_HOLD):\s*([a-z_0-9]+)$/;

/** A title for a finding whose figures could not be shown (an older record nothing could be worked out for). */
export const TITLE: Record<string, string> = {
  "EXC-PRICE_VAR": "Price differs from the order",
  "EXC-QTY_VAR": "Billed for more than was delivered",
  "EXC-UNMATCHED_LINE": "Billed for things not on the order",
  "EXC-UOM_MISMATCH": "Billed in a different unit than ordered",
  "EXC-TAX_VAR": "Tax differs from the rate",
  "EXC-BLANKET_EXCEEDED": "Spending limit on the order exceeded",
  "EXC-BEFORE_RCV": "Billed before the goods arrived",
  "EXC-CURRENCY": "Currency differs from the order",
  "EXC-NON_PO": "No purchase order",
  "EXC-NO_PO": "Order missing or closed",
  "EXC-CREDIT_MEMO": "Credit memo to check",
  "EXC-FRAUD_BANK": "The vendor's bank account changed",
  "EXC-DUPLICATE": "Already received",
  "EXC-LAYOUT": "The document could not be read clearly",
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The same figures the engine records, worked out from the order comparison for a record made before it recorded them. */
function workedOut(code: string, action: Action, inp: MismatchInput): FactShown[] {
  const tw = inp.threeWay;
  const currency = tw?.currency || inp.bill.currency;
  switch (code) {
    case "EXC-PRICE_VAR":
      return (tw?.lines ?? []).filter((l) => l.invoice && (l.flags.includes("price_over") || l.flags.includes("price_under"))).map((l) => facts.priceVariance({
        lineNumber: l.lineNumber, description: l.description, uom: l.uom, billedPrice: l.invoice!.unitPrice, poPrice: l.unitPrice, billedQty: l.invoice!.qty,
        variancePct: l.priceVariancePct ?? 0, impact: Math.abs(l.invoice!.unitPrice - l.unitPrice) * l.invoice!.qty, currency, action,
      }).shown);
    case "EXC-QTY_VAR":
      return (tw?.lines ?? []).filter((l) => l.invoice && (l.flags.includes("qty_over_received") || l.flags.includes("qty_over_ordered"))).map((l) => {
        const excess = Math.max(0, l.invoice!.qty - Math.min(l.qtyReceived, l.qtyOrdered));
        return facts.quantityVariance({
          lineNumber: l.lineNumber, description: l.description, uom: l.uom, ordered: l.qtyOrdered, acceptedReceived: l.qtyReceived, billedBefore: 0,
          billedNow: l.invoice!.qty, excess, impact: excess * l.unitPrice, currency, action,
        }).shown;
      });
    case "EXC-UNMATCHED_LINE": {
      const lines = tw?.unmatchedInvoiceLines ?? [];
      if (!tw || lines.length === 0) return [];
      return [facts.unmatchedLines({ poNumber: tw.poNumber, lines, total: lines.reduce((s, l) => s + Math.abs(l.amount), 0), currency, action }).shown];
    }
    case "EXC-UOM_MISMATCH": {
      const open = (tw?.lines ?? []).filter((l) => !l.invoice);
      for (const billed of tw?.unmatchedInvoiceLines ?? []) {
        const po = open.find((p) => p.uom !== billed.uom && descriptionSimilarity(p.description, billed.description) >= 0.85);
        if (po) {
          return [facts.uomMismatch({
            invoiceDescription: billed.description, invoiceUom: billed.uom, poLineNumber: po.lineNumber, poDescription: po.description, poUom: po.uom,
            plausible: isPlausibleUomConversion(billed.uom, po.uom), action,
          }).shown];
        }
      }
      return [];
    }
    case "EXC-BLANKET_EXCEEDED":
      // Only when this invoice alone is over: earlier invoices on the order are not part of the comparison.
      return tw?.ceiling != null && inp.bill.amount > tw.ceiling
        ? [facts.blanketValue({ poNumber: tw.poNumber, ceiling: tw.ceiling, prior: 0, current: inp.bill.amount, currency: inp.bill.currency, action }).shown]
        : [];
    case "EXC-BEFORE_RCV": {
      if (!tw) return [];
      const earliest = tw.receipts.map((r) => r.date).sort()[0] ?? null;
      if (!earliest) return [facts.beforeReceipt({ poNumber: tw.poNumber, invoiceDate: inp.bill.invoiceDate, earliestReceipt: null, action }).shown];
      const gapDays = Math.round((Date.parse(earliest) - Date.parse(inp.bill.invoiceDate)) / DAY_MS);
      return gapDays > 7 ? [facts.beforeReceipt({ poNumber: tw.poNumber, invoiceDate: inp.bill.invoiceDate, earliestReceipt: earliest, gapDays, action }).shown] : [];
    }
    case "EXC-CURRENCY":
      return tw && tw.currency !== inp.bill.currency
        ? [facts.currencyMismatch({ billCurrency: inp.bill.currency, poCurrency: tw.currency, poNumber: tw.poNumber, billRate: 1, poRate: 1, ratePct: 0, action }).shown]
        : [];
    case "EXC-NON_PO":
      return [facts.nonPo({
        amount: inp.bill.amount, currency: inp.bill.currency, printedPoReference: inp.bill.hasPo ? null : inp.bill.poReference,
        trustTier: inp.vendorTrustTier ?? "new", action,
      }).shown];
    case "EXC-NO_PO":
      return inp.bill.poReference || tw ? [facts.noPo({ poReference: tw?.poNumber ?? inp.bill.poReference!, poStatus: tw?.poStatus ?? "not_found", action }).shown] : [];
    case "EXC-FRAUD_BANK":
      return inp.bankChange
        ? [facts.bankChange({ status: inp.bankChange.status, action, oldLast4: inp.bankChange.oldBankLast4, newLast4: inp.bankChange.newBankLast4 }).shown]
        : [];
    default:
      return [];
  }
}

/** A failed pre-match gate ("readability: failed - OCR confidence 72% ...") in plain words. */
function gateMismatch(check: string, reason: string): MismatchView | null {
  const ocr = /OCR confidence (\d+)%/.exec(reason)?.[1];
  const plain: Record<string, { code: string; title: string; point: FactPoint }> = {
    readability: { code: "EXC-LAYOUT", title: TITLE["EXC-LAYOUT"], point: { source: "records", label: "How sure the reader was", value: ocr ? `${ocr}%; at least 85% is needed` : reason, wrong: true } },
    duplicate: reason.startsWith("Looks like")
      ? { code: "EXC-DUPLICATE", title: "Looks like one already received", point: { source: "records", label: "On file", value: reason.replace(/^Looks like invoice (\S+) already on file: /, "Invoice $1: "), wrong: true } }
      : { code: "EXC-DUPLICATE", title: TITLE["EXC-DUPLICATE"], point: { source: "records", label: "On file", value: "This vendor already sent an invoice with this number", wrong: true } },
    vendor_status: { code: "VENDOR_FLAGGED", title: "The vendor is flagged", point: { source: "records", label: "Vendor", value: "Flagged: nothing is processed automatically until it is cleared", wrong: true } },
    currency: { code: "EXC-CURRENCY", title: "Currency not supported", point: { source: "invoice", label: "Currency", value: reason.replace(/^Currency /, ""), wrong: true } },
    invoice_date: { code: "INVOICE_DATE", title: "Invoice date out of range", point: { source: "invoice", label: "Invoice date", value: reason.replace(/^Invoice date /, ""), wrong: true } },
    mandatory_fields: { code: "MISSING_FIELDS", title: "Details missing from the invoice", point: { source: "invoice", label: "Missing", value: "One or more required details (vendor, number, date, total, lines)", wrong: true } },
  };
  const p = plain[check];
  return p ? { code: p.code, title: p.title, points: [p.point], text: `${check}: failed - ${reason}`, source: "recorded" } : null;
}

export function mismatchesFor(inp: MismatchInput): MismatchView[] {
  const out: MismatchView[] = [];

  for (const c of inp.validate?.claims ?? []) {
    const m = /^([a-z_]+): failed - (.+)$/.exec(c);
    const view = m ? gateMismatch(m[1], m[2]) : null;
    if (view) out.push(view);
  }

  const claims = inp.match?.claims ?? [];
  const workedOutCodes = new Set<string>();
  for (let i = 0; i < claims.length; i++) {
    const m = FINDING_LINE.exec(claims[i].trim());
    if (!m || !m[1].startsWith("EXC-") || m[2] === "auto_approve") continue;
    const code = m[1];
    const action = m[2] as Action;
    const next = claims[i + 1];
    const text = next != null && !FINDING_LINE.test(next.trim()) ? next : null;
    const shown = text ? inp.match?.shown?.[i + 1] ?? null : null;
    if (shown) {
      out.push({ code, title: shown.title, points: shown.points, text, source: "recorded" });
      continue;
    }
    // An older record: every finding of this code is worked out at once from the comparison.
    if (workedOutCodes.has(code)) continue;
    workedOutCodes.add(code);
    const derived = workedOut(code, action, inp);
    if (derived.length > 0) out.push(...derived.map((d) => ({ code, title: d.title, points: d.points, text, source: "worked_out" as const })));
    else out.push({ code, title: TITLE[code] ?? code, points: [], text, source: "recorded" });
  }

  // A bank change can hold an invoice the match step saw before the change: the hold is still what is wrong.
  if (inp.bankChange && !out.some((v) => v.code === "EXC-FRAUD_BANK")) {
    const d = workedOut("EXC-FRAUD_BANK", "block_fraud_flag", inp)[0];
    if (d) out.unshift({ code: "EXC-FRAUD_BANK", title: d.title, points: d.points, text: null, source: "worked_out" });
  }
  return out;
}
