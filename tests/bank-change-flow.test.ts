import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { getSql } from "@/db/client";
import { getOrCreateBankChangeReview, detectBankChangeGate } from "@/lib/ledger/bank-change-review";
import { approveInvoice } from "@/lib/ledger/human-review";
import { POST as startCallback } from "@/app/api/reviews/[id]/callback/route";
import { POST as recordOutcome } from "@/app/api/reviews/[id]/outcome/route";
import { POST as signOff } from "@/app/api/reviews/[id]/sign-off/route";

/**
 * The vendor bank-detail change control, end to end through the real route handlers: the
 * reviewer who phones the vendor logs the call and attests to the answer, a DIFFERENT reviewer
 * signs off, and only then can the invoice be approved. Before, the voice module recorded
 * "confirmed" by itself on every call, and nothing could ever sign off.
 */

const sql = getSql();
const TAG = "BC-" + randomUUID().slice(0, 6);

const call = (handler: any, id: string, body: unknown) =>
  handler(new Request("http://test.local/x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) }) as Promise<Response>;

async function scenario() {
  const vendorId = randomUUID();
  await sql`INSERT INTO vendors (id, name, trust_tier, bank_account_last4, bank_account_changed_at)
            VALUES (${vendorId}, ${TAG + " Vendor " + vendorId.slice(0, 5)}, 'new', '9999', ${new Date(Date.now() - 2 * 86_400_000).toISOString()})`;
  const billId = randomUUID();
  await sql`INSERT INTO vendor_bills (id, vendor_id, invoice_number, invoice_date, subtotal, total_amount, status)
            VALUES (${billId}, ${vendorId}, ${TAG + "-" + billId.slice(0, 5)}, '2026-10-01', 800, 800, 'exception')`;
  await sql`INSERT INTO vendor_bill_lines (id, vendor_bill_id, description, qty_invoiced, unit_price, gl_account_id)
            VALUES (${randomUUID()}, ${billId}, 'Services', 1, 800, '6000')`;
  const { review } = await getOrCreateBankChangeReview({ vendorId, oldBankLast4: '1111', newBankLast4: '9999', sourceInvoiceId: billId });
  return { vendorId, billId, reviewId: review.id };
}

describe("vendor bank-change verification", () => {
  it("holds payment until the callback is made, attested, and signed off by a different person", async () => {
    const { vendorId, billId, reviewId } = await scenario();

    // 1. Nothing can be approved while the change is unverified.
    await expect(approveInvoice({ billId, reviewer: "Anita" })).rejects.toMatchObject({ status: 409 });

    // 2. Anita phones the vendor. Logging the call must NOT confirm anything.
    const started = await call(startCallback, reviewId, { reviewerName: "Anita", phoneNumber: "+1 415 555 0100" });
    expect(started.status).toBe(200);
    const startedBody = await started.json();
    expect(startedBody.status).toBe("awaiting_outcome");
    expect(startedBody.simulated).toBe(true);
    expect(startedBody.review.status).toBe("callback_pending");
    expect(startedBody.script).toMatch(/NOT a number from the change request/);
    expect((await detectBankChangeGate(vendorId)).gating).toBe(true);

    // 3. Only the person who made the call may say the vendor confirmed.
    const stranger = await call(recordOutcome, reviewId, { reviewerName: "Bilal", outcome: "confirmed" });
    expect(stranger.status).toBe(409);
    expect((await stranger.json()).error).toMatch(/only Anita/);
    const confirmed = await call(recordOutcome, reviewId, { reviewerName: "Anita", outcome: "confirmed" });
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()).review.status).toBe("callback_confirmed");

    // 4. Confirmed is still not enough: the hold stays until a second person signs off.
    expect((await detectBankChangeGate(vendorId)).gating).toBe(true);
    await expect(approveInvoice({ billId, reviewer: "Bilal" })).rejects.toMatchObject({ status: 409 });

    // 5. Maker/checker: the caller cannot sign off their own callback.
    const self = await call(signOff, reviewId, { reviewerName: "Anita" });
    expect(self.status).toBe(409);
    expect((await self.json()).error).toMatch(/maker\/checker/);

    // 6. A different reviewer signs off; the hold lifts and the invoice can be approved and paid.
    const checked = await call(signOff, reviewId, { reviewerName: "Bilal" });
    expect(checked.status).toBe(200);
    expect((await detectBankChangeGate(vendorId)).gating).toBe(false);
    const out = await approveInvoice({ billId, reviewer: "Bilal" });
    expect(out.alreadyDone).toBe(false);
    expect((await sql`SELECT status FROM vendor_bills WHERE id = ${billId}`)[0].status).toBe("paid");
  });

  it("a failed callback flags the vendor and the hold never lifts", async () => {
    const { vendorId, billId, reviewId } = await scenario();
    await call(startCallback, reviewId, { reviewerName: "Anita", phoneNumber: "+1 415 555 0100" });
    const failed = await call(recordOutcome, reviewId, { reviewerName: "Anita", outcome: "failed" });
    expect(failed.status).toBe(200);
    expect((await sql`SELECT trust_tier FROM vendors WHERE id = ${vendorId}`)[0].trust_tier).toBe("flagged");
    const gate = await detectBankChangeGate(vendorId);
    expect(gate).toMatchObject({ gating: true, status: "callback_failed" });
    await expect(approveInvoice({ billId, reviewer: "Bilal" })).rejects.toMatchObject({ status: 409 });
    // and it can't be confirmed afterwards
    const late = await call(recordOutcome, reviewId, { reviewerName: "Anita", outcome: "confirmed" });
    expect(late.status).toBe(409);
  });

  it("cannot confirm a call that was never logged, and validates its input", async () => {
    const { reviewId } = await scenario();
    const noCall = await call(recordOutcome, reviewId, { reviewerName: "Anita", outcome: "confirmed" });
    expect(noCall.status).toBe(409);
    expect((await noCall.json()).error).toMatch(/without a logged callback attempt/);

    expect((await call(startCallback, reviewId, { reviewerName: "Anita", phoneNumber: "not a phone" })).status).toBe(400);
    expect((await call(startCallback, reviewId, { phoneNumber: "+1 415 555 0100" })).status).toBe(400); // no reviewer name
    expect((await call(recordOutcome, reviewId, { reviewerName: "Anita", outcome: "maybe" })).status).toBe(400);
    expect((await call(startCallback, randomUUID(), { reviewerName: "Anita", phoneNumber: "+1 415 555 0100" })).status).toBe(404);
    const badJson = await startCallback(new Request("http://test.local/x", { method: "POST", body: "{nope" }), { params: Promise.resolve({ id: reviewId }) });
    expect(badJson.status).toBe(400);
  });
});
