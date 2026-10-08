import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { getSql } from "@/db/client";
import { postBillApproval } from "@/lib/ledger/journal";
import { triggerPayment, SIMULATED_REFERENCE_PREFIX } from "@/lib/payments/payments";

const sql = getSql();

async function postedBill(amount = 640) {
  const vendorId = randomUUID(), billId = randomUUID();
  await sql`INSERT INTO vendors (id, name, trust_tier) VALUES (${vendorId}, ${"PAY Vendor " + vendorId.slice(0, 6)}, 'trusted')`;
  await sql`INSERT INTO vendor_bills (id, vendor_id, invoice_number, invoice_date, subtotal, total_amount, status)
            VALUES (${billId}, ${vendorId}, ${"PAY-" + billId.slice(0, 6)}, '2026-10-01', ${amount}, ${amount}, 'exception')`;
  await sql`INSERT INTO vendor_bill_lines (id, vendor_bill_id, description, qty_invoiced, unit_price, gl_account_id) VALUES (${randomUUID()}, ${billId}, 'Services', 1, ${amount}, '6000')`;
  await postBillApproval(billId);
  return billId;
}

describe("triggerPayment", () => {
  it("records a payment that says it is simulated, posts Dr AP / Cr Cash, and marks the bill paid", async () => {
    const billId = await postedBill(640);
    const r = await triggerPayment(billId, 640);
    expect(r.simulated).toBe(true);
    expect(r.reference.startsWith(SIMULATED_REFERENCE_PREFIX)).toBe(true);
    expect(r.alreadyPaid).toBe(false);
    expect((await sql`SELECT status FROM vendor_bills WHERE id = ${billId}`)[0].status).toBe("paid");
    const lines = await sql`SELECT a.account_number, l.debit_amount, l.credit_amount FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.entry_id = ${r.journalEntryId} ORDER BY a.account_number`;
    expect(lines.map((l: any) => [l.account_number, Number(l.debit_amount), Number(l.credit_amount)])).toEqual([["1000", 0, 640], ["2000", 640, 0]]);
  });

  it("paying twice (a retry, a re-run audit stage) pays once", async () => {
    const billId = await postedBill(310);
    const first = await triggerPayment(billId, 310);
    const second = await triggerPayment(billId, 310);
    expect(second.paymentId).toBe(first.paymentId);
    expect(second.alreadyPaid).toBe(true);
    expect(await sql`SELECT 1 FROM payments p JOIN payment_applications pa ON pa.payment_id = p.id WHERE pa.vendor_bill_id = ${billId}`).toHaveLength(1);
  });

  it("paying concurrently pays once", async () => {
    const billId = await postedBill(275);
    await Promise.allSettled([triggerPayment(billId, 275), triggerPayment(billId, 275), triggerPayment(billId, 275)]);
    expect(await sql`SELECT 1 FROM payment_applications WHERE vendor_bill_id = ${billId}`).toHaveLength(1);
  });

  it("refuses a non-positive amount before writing anything", async () => {
    const billId = await postedBill(100);
    await expect(triggerPayment(billId, 0)).rejects.toThrow(/non-positive/);
    await expect(triggerPayment(billId, -5)).rejects.toThrow(/non-positive/);
    expect(await sql`SELECT 1 FROM payment_applications WHERE vendor_bill_id = ${billId}`).toHaveLength(0);
  });
});
