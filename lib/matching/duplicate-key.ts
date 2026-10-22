import { descriptionSimilarity } from "./line-match";

/**
 * The same invoice number written two ways: "INV-001", "inv 0001", "INV/1" and "INV-0001" are one number to a person,
 * and to a vendor sending the same bill twice. The key keeps the letters and the value of each run of digits:
 * upper-cased, separators dropped, leading zeros dropped. "INV-12" and "INV-120" stay different. Pure.
 */
export function invoiceNumberKey(invoiceNumber: string): string {
  const parts = invoiceNumber.toUpperCase().match(/[A-Z]+|\d+/g) ?? [];
  return parts.map((p) => (/^\d+$/.test(p) ? String(BigInt(p)) : p)).join("|");
}

export interface DuplicateCandidate {
  invoiceNumber: string;
  invoiceDate: string;
  total: number;
  lines: Array<{ description: string; qty: number; unitPrice: number }>;
}

/** Spec §2 EXC-05's fuzzy duplicate: amount within $1, date within a day, and line items this alike (0-1). */
const AMOUNT_TOLERANCE = 1;
const DATE_TOLERANCE_DAYS = 1;
const LINE_SIMILARITY = 0.9;
const DAY_MS = 864e5;

/**
 * Whether `bill` looks like a copy of one of `candidates` (same vendor and invoice type, chosen by the caller), and
 * why, in words; null when none does. An exact number match is the caller's own check (it rejects outright); this one
 * only holds the invoice for a person, since a near match can be a genuine second bill. Two ways to match, both with
 * the amount within $1:
 *  - the same number written differently (INV-001 / INV-0001), whatever the date;
 *  - spec §2 EXC-05: dated within a day of each other, with the same lines (each line the same quantity and price, and
 *    descriptions at least 90% alike).
 * Pure.
 */
export function nearDuplicateOf(bill: DuplicateCandidate, candidates: DuplicateCandidate[]): { invoiceNumber: string; why: string } | null {
  const key = invoiceNumberKey(bill.invoiceNumber);
  for (const c of candidates) {
    if (c.invoiceNumber === bill.invoiceNumber) continue; // the exact match is checked, and rejected, separately
    if (Math.abs(c.total - bill.total) > AMOUNT_TOLERANCE) continue;
    if (key !== "" && invoiceNumberKey(c.invoiceNumber) === key) {
      return { invoiceNumber: c.invoiceNumber, why: `the same number written differently (${c.invoiceNumber} and ${bill.invoiceNumber}) for the same amount` };
    }
    const days = Math.abs(new Date(c.invoiceDate).getTime() - new Date(bill.invoiceDate).getTime()) / DAY_MS;
    if (days <= DATE_TOLERANCE_DAYS && sameLines(bill.lines, c.lines)) {
      return { invoiceNumber: c.invoiceNumber, why: `the same amount, lines and date (within a day) as ${c.invoiceNumber}` };
    }
  }
  return null;
}

function sameLines(a: DuplicateCandidate["lines"], b: DuplicateCandidate["lines"]): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  const left = [...b];
  for (const line of a) {
    const i = left.findIndex((o) => o.qty === line.qty && Math.abs(o.unitPrice - line.unitPrice) < 0.005
      && descriptionSimilarity(o.description.toLowerCase(), line.description.toLowerCase()) >= LINE_SIMILARITY);
    if (i < 0) return false;
    left.splice(i, 1);
  }
  return true;
}
