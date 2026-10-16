import { createHash } from "node:crypto";
import { getSql } from "@/db/client";
import { postPayment, applyVendorCredits, creditMemoUses, type CreditUse } from "@/lib/ledger/journal";
import { money } from "@/lib/matching/finding-facts";

/**
 * Pays a posted bill: records the payment and posts Dr Accounts Payable / Cr Cash.
 *
 * THE PAYMENT RAIL IS SIMULATED. No money moves; the payments row's `positive_pay_reference`
 * says so ("SIMULATED-…") and every API response and screen that shows a payment carries that
 * label. This replaces an earlier version that tried a hard-coded Dodo host
 * (sandbox.dodopayments.com — which does not resolve in DNS), swallowed the failure with a
 * console.warn, and then recorded a mock payment anyway: a "real disbursement" that had never
 * once reached a provider. A real rail belongs behind this same function — call the provider
 * first, and on any failure throw BEFORE writing the payment or the ledger entry.
 *
 * Idempotent: the payment id is derived from the bill id, so running the audit stage twice
 * (a retry, a reconsideration cascade) cannot pay the same bill twice — the second call finds
 * the existing payment and only (re)posts the ledger entry if that is what was missing.
 *
 * A credit memo is refused before anything is written: a credit is money the vendor owes back.
 * Callers settle through settleApprovedBill (below), which works out what is owed.
 */
export const SIMULATED_REFERENCE_PREFIX = "SIMULATED-";

export interface PaymentResult {
  paymentId: string;
  journalEntryId: string;
  reference: string;
  simulated: boolean;
  /** true when this bill already had a payment and nothing new was created. */
  alreadyPaid: boolean;
}

function paymentIdFor(billId: string): string {
  return `pay-${createHash("sha256").update(`payment:${billId}`).digest("hex").slice(0, 32)}`;
}

export async function triggerPayment(billId: string, amount: number): Promise<PaymentResult> {
  if (!(amount > 0)) throw new Error(`triggerPayment: refusing to pay a non-positive amount (${amount}) for bill ${billId}`);
  const sql = getSql();
  // Checked before the payments row is written: a refused payment must leave nothing behind.
  const billRows = await sql`SELECT invoice_type FROM vendor_bills WHERE id = ${billId}`;
  if (billRows.length === 0) throw new Error(`triggerPayment: no vendor_bill found with id '${billId}'`);
  if (billRows[0].invoice_type === "credit_memo") {
    throw new Error(`triggerPayment: refusing to pay credit memo ${billId} — a credit lowers what is owed to the vendor and is never paid out`);
  }
  const paymentId = paymentIdFor(billId);

  const existing = await sql`SELECT id, journal_entry_id, positive_pay_reference FROM payments WHERE id = ${paymentId}`;
  let reference: string;
  let alreadyPaid = false;
  if (existing.length > 0) {
    reference = existing[0].positive_pay_reference ?? "";
    alreadyPaid = Boolean(existing[0].journal_entry_id);
  } else {
    reference = `${SIMULATED_REFERENCE_PREFIX}${paymentId.slice(4, 12)}`;
    const paymentDate = new Date().toISOString().slice(0, 10);
    await sql`
      INSERT INTO payments (id, method, payment_date, total_amount, positive_pay_reference)
      VALUES (${paymentId}, 'ach', ${paymentDate}, ${amount}, ${reference})
      ON CONFLICT (id) DO NOTHING
    `;
  }

  // postPayment is itself idempotent (keyed on the payment id), so this is safe to repeat.
  const result = await postPayment(paymentId, [{ vendorBillId: billId, appliedAmount: amount }]);
  return { paymentId, journalEntryId: result.journalEntryId, reference, simulated: reference.startsWith(SIMULATED_REFERENCE_PREFIX), alreadyPaid };
}

/** What settling an approved, posted invoice did. */
export type Settlement =
  /** A credit memo: posting it lowered what is owed to the vendor. Nothing is paid; `uses` is where its credit went so far. */
  | { kind: "credit_memo"; uses: Array<{ invoiceNumber: string; amount: number }>; unused: number }
  /** The vendor's approved credit covers all of the invoice. Nothing is paid. */
  | { kind: "covered_by_credit"; credited: number; credits: CreditUse[] }
  /** Paid what was still owed: the total less the vendor's approved credit taken off it. */
  | { kind: "paid"; payment: PaymentResult; amount: number; credited: number; credits: CreditUse[] };

/**
 * Settles an invoice that has just been approved and posted — the one place both approve paths
 * (the pipeline's audit stage, a person's Approve) decide whether money goes out. A credit memo is
 * never paid. Any other invoice first takes the vendor's unused approved credit in its currency,
 * oldest first (applyVendorCredits, which records each use), and is paid the rest: nothing at all
 * when the credit covers it.
 *
 * Throws only when the payment itself fails; the invoice is posted either way, and the credit it
 * took stays taken (it is paid the rest when settled again).
 */
export async function settleApprovedBill(billId: string): Promise<Settlement> {
  const sql = getSql();
  const rows = await sql`SELECT total_amount, invoice_type FROM vendor_bills WHERE id = ${billId}`;
  if (rows.length === 0) throw new Error(`settleApprovedBill: no vendor_bill found with id '${billId}'`);
  if (rows[0].invoice_type === "credit_memo") return { kind: "credit_memo", ...await creditMemoUses(sql, billId) };

  const credits = await applyVendorCredits(billId);
  const credited = Math.round(credits.reduce((s, c) => s + c.amount, 0) * 100) / 100;
  const owed = Math.round((Number(rows[0].total_amount) - credited) * 100) / 100;
  if (owed <= 0) return { kind: "covered_by_credit", credited, credits };
  return { kind: "paid", payment: await triggerPayment(billId, owed), amount: owed, credited, credits };
}

/** "A", "A and B", "A, B and C". */
function listWords(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "credit memo INV-1-CM" for one credit; each one's amount as well when there are several. */
function creditSources(credits: CreditUse[], currency: string): string {
  if (credits.length === 1) return `credit memo ${credits[0].creditMemoNumber}`;
  return `credit memos ${listWords(credits.map((c) => `${c.creditMemoNumber} (${money(c.amount, currency)})`))}`;
}

/** One sentence for the trail when settling was not simply "paid in full"; null when it was. No "Label:" opening: the trail shows those as headings. */
export function settlementNote(s: Settlement, currency: string): string | null {
  switch (s.kind) {
    case "credit_memo": {
      const parts = ["A credit memo is never paid. Posting it lowered what is owed to the vendor."];
      const usedTotal = s.uses.reduce((sum, u) => sum + u.amount, 0);
      if (s.uses.length > 0) {
        parts.push(`${money(usedTotal, currency)} of it came off invoice${s.uses.length === 1 ? "" : "s"} ${listWords(s.uses.map((u) => u.invoiceNumber))}.`);
      }
      if (s.unused > 0) {
        parts.push(`${s.uses.length > 0 ? `The other ${money(s.unused, currency)}` : `All ${money(s.unused, currency)} of it`} comes off the vendor's next approved invoices in ${currency}.`);
      }
      return parts.join(" ");
    }
    case "covered_by_credit":
      return `${money(s.credited, currency)} of the vendor's approved credit, from ${creditSources(s.credits, currency)}, covers all of this invoice. Nothing is paid.`;
    case "paid":
      return s.credited > 0
        ? `Paid ${money(s.amount, currency)}, the total less ${money(s.credited, currency)} of the vendor's approved credit, from ${creditSources(s.credits, currency)}.`
        : null;
  }
}
