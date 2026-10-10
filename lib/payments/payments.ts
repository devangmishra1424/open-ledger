import { createHash } from "node:crypto";
import { getSql } from "@/db/client";
import { postPayment } from "@/lib/ledger/journal";

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
