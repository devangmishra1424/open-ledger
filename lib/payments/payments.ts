import { createHash } from "node:crypto";
import { getSql } from "@/db/client";
import { postPayment, creditsPostedAgainst } from "@/lib/ledger/journal";
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
  /** A credit memo: posting it already lowered what is owed to the vendor. Nothing is paid. */
  | { kind: "credit_memo" }
  /** Credit memos posted against the invoice already cover all of it. Nothing is paid. */
  | { kind: "covered_by_credit"; credited: number }
  /** Paid what was still owed: the total less any credit memos posted against it. */
  | { kind: "paid"; payment: PaymentResult; amount: number; credited: number };

/**
 * Settles an invoice that has just been approved and posted — the one place both approve paths
 * (the pipeline's audit stage, a person's Approve) decide whether money goes out. A credit memo is
 * never paid. Any other invoice is paid its total less the credit memos already posted against it
 * (vendor_bills.related_invoice_id), and nothing at all when those credits cover it.
 *
 * Throws only when the payment itself fails; the invoice is posted either way.
 */
export async function settleApprovedBill(billId: string): Promise<Settlement> {
  const sql = getSql();
  const rows = await sql`SELECT total_amount, invoice_type FROM vendor_bills WHERE id = ${billId}`;
  if (rows.length === 0) throw new Error(`settleApprovedBill: no vendor_bill found with id '${billId}'`);
  if (rows[0].invoice_type === "credit_memo") return { kind: "credit_memo" };

  const credited = await creditsPostedAgainst(sql, billId);
  const owed = Math.round((Number(rows[0].total_amount) - credited) * 100) / 100;
  if (owed <= 0) return { kind: "covered_by_credit", credited };
  return { kind: "paid", payment: await triggerPayment(billId, owed), amount: owed, credited };
}

/** One sentence for the trail when settling was not simply "paid in full"; null when it was. No "Label:" opening: the trail shows those as headings. */
export function settlementNote(s: Settlement, currency: string): string | null {
  switch (s.kind) {
    case "credit_memo":
      return "A credit memo is never paid. Posting it lowered what is owed to the vendor.";
    case "covered_by_credit":
      return `Credit memos of ${money(s.credited, currency)} posted against this invoice cover all of it. Nothing is paid.`;
    case "paid":
      return s.credited > 0
        ? `Paid ${money(s.amount, currency)}, the total less ${money(s.credited, currency)} of credit memos posted against it.`
        : null;
  }
}
