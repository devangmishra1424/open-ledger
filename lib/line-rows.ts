/**
 * Reading ONE line item out of a table row of a document (an invoice or a purchase order), the way
 * PDF text extraction hands it over: cells separated by spaces, tabs, pipes or commas.
 *
 *   Widget A      10     $5.00     $50.00
 *   Widget A | 10 | 5.00 | 50.00
 *   1  Zinc Bolt M8x40  200  0.75  150.00
 *   Consulting, 2, 400.00
 *
 * Rules, so a wrong read is refused rather than guessed:
 *  - the row ends in 2 or 3 numbers: quantity, unit price and (optionally) the line amount;
 *  - when the line amount is there it MUST equal quantity x unit price (to the cent), otherwise the
 *    row is not read at all;
 *  - totals lines ("Subtotal", "Tax", "Total", ...) are never rows.
 * Callers only use this after a table header has been seen, and the document-level arithmetic
 * (lines add up to the subtotal) still has the last word on whether the read is trusted.
 */

export interface LineRow { description: string; quantity: number; unitPrice: number }

const CENT = 0.011;
const NUM = String.raw`[$€£₹]?\s?\d[\d,]*(?:\.\d+)?`;
const UNIT = String.raw`(?:pcs?|nos?|each|ea|units?|kgs?|ltrs?|hrs?|hours?|boxes|box|packs?|sets?|licen[cs]es?|months?|days?)`;

/** description, quantity, optional unit word, unit price, optional line amount. */
const ROW = new RegExp(
  String.raw`^(?:\d{1,3}[.)]?\s+)?(.+?)[\s|,;]+(\d[\d,]*(?:\.\d+)?)(?:\s+${UNIT}\b\.?)?\s*(?:x|×|@|[|,;])?\s*(${NUM})(?:\s*(?:=|[|,;])?\s*(${NUM}))?\s*$`,
  "i",
);

/** "Description  Qty  Unit Price  Amount" and the usual variants: the row that announces a table of line items. */
export const TABLE_HEADER = /^(?:#\s*|no\.?\s*|sr\.?\s*(?:no\.?)?\s*)?(?:item|description|particulars|product|service)s?\b.*\b(?:qty|quantity)\b.*\b(?:price|rate|cost)\b/i;

const TOTALS_WORDS = /^(?:sub\s*-?\s*total|total|grand\s+total|tax|vat|gst|igst|cgst|sgst|utgst|sales\s+tax|amount\s+due|balance(?:\s+due)?|discount|shipping|freight|round(?:ing)?(?:\s+off)?)\b/i;

export function toNumber(raw: string): number {
  return parseFloat(raw.replace(/[$€£₹,\s]/g, ""));
}

/** Null when the line is not a readable row; never a guess. */
export function parseLineRow(line: string): LineRow | null {
  const text = line.trim();
  if (text === "" || TOTALS_WORDS.test(text)) return null;
  const m = text.match(ROW);
  if (!m) return null;

  const description = m[1].replace(/[\s|,;:–—-]+$/, "").trim();
  if (description.length < 2 || !/[A-Za-z]/.test(description) || TOTALS_WORDS.test(description)) return null;

  const quantity = toNumber(m[2]);
  const unitPrice = toNumber(m[3]);
  if (!Number.isFinite(quantity) || !Number.isFinite(unitPrice) || quantity <= 0 || unitPrice < 0) return null;

  if (m[4] !== undefined) {
    const amount = toNumber(m[4]);
    if (!Number.isFinite(amount) || Math.abs(quantity * unitPrice - amount) > CENT) return null;
  }
  return { description, quantity, unitPrice };
}

/**
 * A totals line in a table-style document, where labels usually have no colon:
 * "Subtotal 750.00", "Tax (8%) $60.00", "Total $810.00". The LAST number on the line is the amount.
 */
export function parseTotalsLine(line: string): { kind: "subtotal" | "tax" | "total"; amount: number } | null {
  const text = line.trim();
  const amountAtEnd = text.match(new RegExp(String.raw`(${NUM})\s*$`));
  if (!amountAtEnd) return null;
  // "Total Qty 14", "Total items 3": a count, not money.
  if (/^total\s+(?:qty|quantity|items?|units?|pcs)\b/i.test(text)) return null;
  let kind: "subtotal" | "tax" | "total" | null = null;
  if (/^sub\s*-?\s*total\b/i.test(text)) kind = "subtotal";
  else if (/^(?:sales\s+)?(?:tax|vat|[cs]?gst|igst|utgst)\b/i.test(text)) kind = "tax";
  else if (/^(?:grand\s+total|total(?:\s+amount)?(?:\s+due)?|amount\s+due|balance\s+due)\b/i.test(text)) kind = "total";
  if (!kind) return null;
  const amount = toNumber(amountAtEnd[1]);
  return Number.isFinite(amount) ? { kind, amount } : null;
}
