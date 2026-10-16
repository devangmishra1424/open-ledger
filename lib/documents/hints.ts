import { amountsIn } from "@/lib/documents/formats";

/**
 * Three things a document can say that the books need to know, read by plain rules (no AI) so a person only has
 * to glance at a pre-filled box:
 *   - an invoice that is really a credit note / credit memo (its title says so);
 *   - the bank account the vendor asks to be paid into (only its last 4 digits are ever kept);
 *   - a purchase order's spending limit ("Not to exceed USD 10,000.00"), which makes it a blanket order.
 * Each returns null / false when the document does not say it clearly; nothing is guessed.
 */

const lines = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** How far down a title can be: the heading block at the top of the first page. */
const TITLE_LINES = 15;

/** A heading: "CREDIT NOTE", "Tax Credit Memo", "Credit Note No: CN-77"; not a sentence that mentions one. */
const CREDIT_TITLE = /^(?:tax\s+)?credit\s*(?:note|memo)\b(?:\s*(?:no\.?|number|#)?\s*[:.\-]?\s*[A-Z0-9][A-Z0-9\-\/]*)?$/i;

/** True when the document's heading calls it a credit note or credit memo (not a passing mention lower down). */
export function isCreditNote(text: string): boolean {
  return lines(text).slice(0, TITLE_LINES).some((l) => l.split(/\s*\|\s*|\s{2,}/).some((part) => CREDIT_TITLE.test(part.trim())));
}

/** A line that is about where to pay: a bank, its codes, or a remittance instruction. */
const BANK_CONTEXT = /\b(?:bank|ifsc|sort\s*code|swift|bic|iban|routing|remit(?:tance)?|beneficiary|a\/c)\b/i;
/** Not the vendor's bank account: a customer number, a tax registration. */
const NOT_BANK = /\b(?:customer|client|consumer|gstin|vat\s*(?:no|reg)|pan)\b/i;
/** "A/c No. 004105012345", "Account 43918822", "Account Number: 1234-5678-90", "IBAN GB29 NWBK 6016 1331 9268 19". */
const ACCOUNT = /\b(?:a\/c|acct|account|iban)\.?\s*(?:no\.?|number|num|#)?\s*[:.\-]?\s*([A-Z]{2}\d{2}(?:\s?[A-Z0-9]){10,30}|\d(?:[\s-]?\d){5,20})/i;

/**
 * The last 4 digits of the bank account the document asks to be paid into, or null. Only a line with bank context
 * counts (or the line right after one), and the account must have at least 6 digits, so an order number or a phone
 * number is not taken for it. Only the last 4 digits are returned: nothing more is stored.
 */
export function bankAccountLast4(text: string): string | null {
  const ls = lines(text);
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    if (NOT_BANK.test(l)) continue;
    if (!BANK_CONTEXT.test(l) && !(i > 0 && BANK_CONTEXT.test(ls[i - 1]))) continue;
    const m = ACCOUNT.exec(l);
    if (!m) continue;
    const digits = m[1].replace(/\D/g, "");
    if (digits.length >= 6) return digits.slice(-4);
  }
  return null;
}

const LIMIT = /\b(?:not\s*to\s*exceed|nte|spending\s*limit|maximum\s*(?:order\s*)?(?:value|amount)|blanket\s*(?:order\s*)?(?:limit|amount|value|ceiling)|order\s*ceiling|ceiling\s*(?:amount|value))\b/i;

/** A purchase order's spending limit ("Not to exceed: $10,000.00", "Blanket order limit INR 5,00,000"), or null. */
export function spendingLimit(text: string): number | null {
  for (const l of lines(text)) {
    const m = LIMIT.exec(l);
    if (!m) continue;
    const after = amountsIn(l.slice(m.index + m[0].length)).find((n) => n > 0);
    if (after != null) return after;
  }
  return null;
}
