import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { getSql } from "@/db/client";
import { createBill } from "@/lib/bills";
import { writeDecision } from "@/lib/ledger/decisions";
import { approveInvoice, rejectInvoice } from "@/lib/ledger/human-review";
import { runMatchStage } from "@/lib/pipeline/match-stage";
import { createPurchaseOrder } from "@/lib/purchase-orders";
import { GET as report } from "@/app/api/audit/reports/[kind]/route";

/**
 * The auditor's period reports through their real route, against the test schema. Other suites share the schema, so
 * each test finds its own rows by a unique tag rather than asserting whole totals.
 */

const sql = getSql();
const TAG = `AR-${randomUUID().slice(0, 6)}`;
const today = new Date().toISOString().slice(0, 10);
const get = async (kind: string, query = "") => {
  const res = await report(new Request(`http://t/api/audit/reports/${kind}${query}`), { params: Promise.resolve({ kind }) });
  return { status: res.status, type: res.headers.get("content-type"), body: res.headers.get("content-type")?.startsWith("text/csv") ? await res.text() : await res.json() };
};

/** A bill held by the checks (as the pipeline would leave it), entered by `enteredBy` through the review screen. */
async function heldBill(n: string, enteredBy: string, amount = 1000) {
  const bill = await createBill({ vendorName: `${TAG} Vendor`, invoiceNumber: `${TAG}-${n}`, invoiceDate: "2026-07-01", strictTotals: true,
    lines: [{ description: "Service", quantity: 1, unitPrice: amount }] });
  const now = new Date().toISOString();
  await writeDecision({ invoiceId: bill.billId, nodeId: "extract", agentId: `human:${enteredBy}`, triggeredByActor: enteredBy, startedAt: now, actionTaken: "extracted", idempotencyKey: `${TAG}-x-${n}` });
  await writeDecision({ invoiceId: bill.billId, nodeId: "policy", agentId: "deterministic-policy-engine", startedAt: now, actionTaken: "escalate_l2", reasonCode: "EXC-NON_PO", idempotencyKey: `${TAG}-p-${n}` });
  await sql`UPDATE vendor_bills SET status = 'exception' WHERE id = ${bill.billId}`;
  return bill;
}

describe("overrides report", () => {
  it("lists what a person decided against a hold, with what the checks said, who, their note, and the warning signs", async () => {
    const a = await heldBill("1", "Priya");
    await approveInvoice({ billId: a.billId, reviewer: "Priya" }); // no note, and she entered it herself
    const b = await heldBill("2", "Priya");
    await rejectInvoice({ billId: b.billId, reviewer: "Sam", note: "Not ordered by anyone here" });

    const { status, body } = await get("overrides", `?from=${today}&to=${today}`);
    expect(status).toBe(200);
    const mine = body.rows.filter((r: any) => r.invoiceNumber.startsWith(TAG));
    expect(mine.find((r: any) => r.invoiceNumber === `${TAG}-1`)).toMatchObject({
      kind: "approved_despite_hold", checksSaid: "Sent to a reviewer (level 2): Non-PO Invoice", by: "Priya", note: null, enteredBy: "Priya",
      flags: ["no_note", "approved_own_entry"],
    });
    expect(mine.find((r: any) => r.invoiceNumber === `${TAG}-2`)).toMatchObject({ kind: "rejected", by: "Sam", note: "Not ordered by anyone here", flags: [] });
  });

  it("CSV for the auditor's spreadsheet, and a bad date or an unknown report is refused", async () => {
    const csv = await get("overrides", `?from=${today}&to=${today}&format=csv`);
    expect(csv.type).toMatch(/text\/csv/);
    expect(String(csv.body).split("\n")[0]).toBe("decisionId,invoiceId,invoiceNumber,vendor,amount,currency,at,kind,checksSaid,by,note,enteredBy,flags");
    expect((await get("overrides", "?from=2026-13-40")).status).toBe(400);
    expect((await get("overrides", `?from=${today}&to=2020-01-01`)).status).toBe(400);
    expect((await get("nonsense")).status).toBe(404);
  });
});

describe("ageing report", () => {
  it("puts an approved, unpaid invoice in its days-past-due bucket and reports the ledger tie-out", async () => {
    const a = await heldBill("3", "Asha", 2500);
    await sql`UPDATE vendor_bills SET due_date = '2026-07-31' WHERE id = ${a.billId}`;
    await approveInvoice({ billId: a.billId, reviewer: "Sam" }); // posts it; paying is simulated, so mark it unpaid again
    await sql`DELETE FROM payment_applications WHERE vendor_bill_id = ${a.billId}`;
    await sql`UPDATE vendor_bills SET status = 'posted' WHERE id = ${a.billId}`;

    const { body } = await get("ageing", "?asOf=2026-10-15");
    expect(body.rows.find((r: any) => r.invoiceNumber === `${TAG}-3`)).toMatchObject({ open: 2500, dueDate: "2026-07-31", daysPastDue: 76, bucket: "61-90" });
    expect(body.ledger).toEqual(expect.objectContaining({ apBalance: expect.any(Number), netOwed: expect.any(Number), difference: expect.any(Number) }));
  });
});

describe("received-not-invoiced (cut-off) report", () => {
  it("goods accepted by the date but not yet billed, valued at the PO price; later billing and later deliveries do not count", async () => {
    const po = await createPurchaseOrder({ vendorName: `${TAG} Supplier`, poNumber: `${TAG}-PO`, currency: "USD",
      lines: [{ description: "Widget", quantity: 10, unitPrice: 5 }], receipt: { lines: [{ lineNumber: 1, quantity: 7 }], receiptDate: "2026-09-25" } });
    const bill = await createBill({ vendorId: po.vendorId, poId: po.poId, invoiceNumber: `${TAG}-W1`, invoiceDate: "2026-09-28", strictTotals: true,
      lines: [{ description: "Widget", quantity: 4, unitPrice: 5 }] });
    await runMatchStage(bill.billId); // pairs the invoice line with the PO line

    const at = async (asOf: string) => (await get("received-not-invoiced", `?asOf=${asOf}`)).body.rows.find((r: any) => r.poNumber === `${TAG}-PO`);
    expect(await at("2026-09-30")).toMatchObject({ received: 7, invoiced: 4, notInvoiced: 3, unitPrice: 5, value: 15 });
    // Before the invoice's date: all 7 received were unbilled.
    expect(await at("2026-09-26")).toMatchObject({ received: 7, invoiced: 0, notInvoiced: 7, value: 35 });
    // Before the delivery: nothing received yet, so nothing owed.
    expect(await at("2026-09-20")).toBeUndefined();
  });
});
