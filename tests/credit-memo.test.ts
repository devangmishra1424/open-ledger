import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { getSql } from "@/db/client";
import { writeDecision, getDecisionsForInvoice } from "@/lib/ledger/decisions";
import { buildBillApprovalDraft, buildCreditMemoDraft, computeIdempotencyKey, postBillApproval, postPayment } from "@/lib/ledger/journal";
import { triggerPayment, settleApprovedBill } from "@/lib/payments/payments";
import { approveInvoice } from "@/lib/ledger/human-review";
import { runAuditStage } from "@/lib/pipeline/orchestrator";
import { runMatchStage } from "@/lib/pipeline/match-stage";

/**
 * A credit memo (invoice_type 'credit_memo', amount stored as a positive magnitude) is money the
 * vendor owes back. Approving one — by a person or by the pipeline — must lower what is owed to the
 * vendor (Dr Accounts Payable, Cr expense) and must never send a payment. Rows are left behind: the
 * test schema is rebuilt on every run, and decisions must not be deleted out of the hash chain.
 */

const sql = getSql();
const TAG = "CM-" + randomUUID().slice(0, 6);

async function makeVendor() {
  const id = randomUUID();
  await sql`INSERT INTO vendors (id, name, trust_tier) VALUES (${id}, ${TAG + " Vendor " + id.slice(0, 6)}, 'new')`;
  return id;
}

/** A bill waiting on a person (status 'exception') with the policy decision that held it. */
async function makeBill(vendorId: string, opts: { amount: number; creditFor?: string; status?: string; reason?: string }) {
  const billId = randomUUID();
  await sql`INSERT INTO vendor_bills (id, vendor_id, invoice_number, invoice_date, subtotal, total_amount, status, invoice_type, related_invoice_id)
            VALUES (${billId}, ${vendorId}, ${TAG + "-" + billId.slice(0, 6)}, '2026-10-01', ${opts.amount}, ${opts.amount}, ${opts.status ?? "exception"},
                    ${opts.creditFor ? "credit_memo" : "standard"}, ${opts.creditFor ?? null})`;
  await sql`INSERT INTO vendor_bill_lines (id, vendor_bill_id, description, qty_invoiced, unit_price, gl_account_id)
            VALUES (${randomUUID()}, ${billId}, ${opts.creditFor ? "Credit: over-billed hours" : "Consulting"}, 1, ${opts.amount}, '6000')`;
  const now = new Date().toISOString();
  const policy = await writeDecision({
    invoiceId: billId, nodeId: "policy", agentId: "deterministic-policy-engine", startedAt: now, endedAt: now,
    actionTaken: "escalate_l1", reasonCode: opts.reason ?? (opts.creditFor ? "EXC-CREDIT_MEMO" : "EXC-PRICE_VAR"), idempotencyKey: `policy:${billId}`,
  });
  return { billId, policy };
}

const paymentsFor = (billId: string) => sql`SELECT applied_amount FROM payment_applications WHERE vendor_bill_id = ${billId}`;
const paymentRowCount = async () => Number((await sql`SELECT count(*)::int AS n FROM payments`)[0].n);
const statusOf = async (billId: string) => (await sql`SELECT status FROM vendor_bills WHERE id = ${billId}`)[0].status as string;

/** The approval entry's lines as [account, debit, credit], AP first. */
async function postingLines(billId: string) {
  const rows = await sql`
    SELECT l.account_id, l.debit_amount, l.credit_amount FROM journal_entry_lines l
    JOIN journal_entries e ON e.id = l.entry_id
    WHERE e.source_type = 'vendor_bill' AND e.source_id = ${billId} ORDER BY l.account_id`;
  return rows.map((r: any) => [r.account_id, Number(r.debit_amount), Number(r.credit_amount)]);
}

describe("buildCreditMemoDraft", () => {
  const input = {
    billId: "cm-1", invoiceNumber: "INV-1-CM", currency: "USD", exchangeRate: 1, totalAmount: 1080, taxTotal: 80,
    apAccountId: "2000", taxAccountId: "2210", lines: [{ accountId: "6000", amount: 1000 }], entryDate: "2026-10-16",
  };

  it("is the bill-approval entry the other way round: Dr Accounts Payable, Cr expense and tax", () => {
    const draft = buildCreditMemoDraft(input);
    expect(draft.lines.map((l) => [l.accountId, l.debitAmount, l.creditAmount])).toEqual([
      ["6000", 0, 1000],
      ["2210", 0, 80],
      ["2000", 1080, 0],
    ]);
    expect(draft.memo).toBe("Credit memo approval: INV-1-CM");
  });

  it("keeps the bill-approval idempotency key, so a credit memo can be posted only once", () => {
    expect(buildCreditMemoDraft(input).idempotencyKey).toBe(buildBillApprovalDraft(input).idempotencyKey);
    expect(buildCreditMemoDraft(input).idempotencyKey).toBe(computeIdempotencyKey("vendor_bill", "cm-1", "bill_approval"));
  });

  it("still refuses an entry that does not balance", () => {
    expect(() => buildCreditMemoDraft({ ...input, totalAmount: 900 })).toThrow(/not balanced/);
  });
});

describe("posting a credit memo (live DB)", () => {
  it("debits Accounts Payable and credits the expense account, then marks it posted", async () => {
    const vendorId = await makeVendor();
    const { billId: invoiceId } = await makeBill(vendorId, { amount: 5000, status: "paid" });
    const { billId: creditId } = await makeBill(vendorId, { amount: 2000, creditFor: invoiceId });

    await postBillApproval(creditId);

    expect(await postingLines(creditId)).toEqual([["2000", 2000, 0], ["6000", 0, 2000]]);
    expect(await statusOf(creditId)).toBe("posted");
  });
});

describe("a credit memo is never paid", () => {
  it("triggerPayment refuses it before writing anything", async () => {
    const vendorId = await makeVendor();
    const { billId: invoiceId } = await makeBill(vendorId, { amount: 5000, status: "paid" });
    const { billId: creditId } = await makeBill(vendorId, { amount: 2000, creditFor: invoiceId });
    await postBillApproval(creditId);
    const before = await paymentRowCount();

    await expect(triggerPayment(creditId, 2000)).rejects.toThrow(/credit memo/);

    expect(await paymentRowCount()).toBe(before);
    expect(await paymentsFor(creditId)).toHaveLength(0);
    expect(await statusOf(creditId)).toBe("posted");
  });

  it("postPayment refuses to apply a payment to it", async () => {
    const vendorId = await makeVendor();
    const { billId: invoiceId } = await makeBill(vendorId, { amount: 5000, status: "paid" });
    const { billId: creditId } = await makeBill(vendorId, { amount: 750, creditFor: invoiceId });
    await postBillApproval(creditId);
    const paymentId = randomUUID();
    await sql`INSERT INTO payments (id, method, payment_date, total_amount) VALUES (${paymentId}, 'ach', '2026-10-16', 750)`;

    await expect(postPayment(paymentId, [{ vendorBillId: creditId, appliedAmount: 750 }])).rejects.toThrow(/credit memo/);

    expect(await paymentsFor(creditId)).toHaveLength(0);
    expect((await sql`SELECT journal_entry_id FROM payments WHERE id = ${paymentId}`)[0].journal_entry_id).toBeNull();
  });

  it("settleApprovedBill pays nothing for it", async () => {
    const vendorId = await makeVendor();
    const { billId: invoiceId } = await makeBill(vendorId, { amount: 5000, status: "paid" });
    const { billId: creditId } = await makeBill(vendorId, { amount: 300, creditFor: invoiceId });
    await postBillApproval(creditId);

    expect(await settleApprovedBill(creditId)).toEqual({ kind: "credit_memo" });
    expect(await paymentsFor(creditId)).toHaveLength(0);
  });

  it("a person approving it: posted against Accounts Payable, no payment, and the trail says so", async () => {
    const vendorId = await makeVendor();
    const { billId: invoiceId } = await makeBill(vendorId, { amount: 12450, status: "paid" });
    const { billId: creditId } = await makeBill(vendorId, { amount: 2000, creditFor: invoiceId });
    const before = await paymentRowCount();

    const out = await approveInvoice({ billId: creditId, reviewer: "Priya" });

    expect(out.alreadyDone).toBe(false);
    expect(out.payment).toBeUndefined();
    expect(out.paymentError).toBeUndefined();
    expect(out.noPayment).toBe("credit_memo");
    expect(await paymentRowCount()).toBe(before);
    expect(await paymentsFor(creditId)).toHaveLength(0);
    expect(await postingLines(creditId)).toEqual([["2000", 2000, 0], ["6000", 0, 2000]]);
    expect(await statusOf(creditId)).toBe("posted");

    const trail = await getDecisionsForInvoice(creditId);
    const human = trail.find((d) => d.nodeId === "human_review")!;
    const settled = trail[trail.length - 1];
    expect(settled.nodeId).toBe("audit");
    expect(settled.parentDecisionId).toBe(human.id);
    expect(settled.actionTaken).toBe("no_payment");
    expect(settled.claims?.[0].text).toMatch(/credit memo.*Nothing is paid/);
  });

  it("approving it twice (a double-click) still pays nothing", async () => {
    const vendorId = await makeVendor();
    const { billId: invoiceId } = await makeBill(vendorId, { amount: 4000, status: "paid" });
    const { billId: creditId } = await makeBill(vendorId, { amount: 400, creditFor: invoiceId });

    await approveInvoice({ billId: creditId, reviewer: "Priya" });
    const again = await approveInvoice({ billId: creditId, reviewer: "Priya" });

    expect(again.alreadyDone).toBe(true);
    expect(await paymentsFor(creditId)).toHaveLength(0);
  });

  it("the pipeline auto-approving it: posted, no payment, and the audit record says why", async () => {
    const vendorId = await makeVendor();
    const { billId: invoiceId } = await makeBill(vendorId, { amount: 10000, status: "exception" });
    const { billId: creditId } = await makeBill(vendorId, { amount: 1500, creditFor: invoiceId, status: "processing" });
    const now = new Date().toISOString();
    const policy = await writeDecision({
      invoiceId: creditId, nodeId: "policy", agentId: "deterministic-policy-engine", startedAt: now, endedAt: now,
      actionTaken: "auto_approve", reasonCode: "EXC-CREDIT_MEMO", idempotencyKey: `policy-auto:${creditId}`,
    });
    const before = await paymentRowCount();

    const audit = await runAuditStage(creditId, policy);

    expect(audit.actionTaken).toBe("auto_approve");
    expect(audit.claims?.[0].text).toMatch(/credit memo.*Nothing is paid/);
    expect(await paymentRowCount()).toBe(before);
    expect(await paymentsFor(creditId)).toHaveLength(0);
    expect(await postingLines(creditId)).toEqual([["2000", 1500, 0], ["6000", 0, 1500]]);
    expect(await statusOf(creditId)).toBe("posted");
  });
});

describe("an approved credit memo comes off what is paid on its invoice", () => {
  it("the related invoice, approved later, is paid its total less the credit, and counts as fully paid", async () => {
    const vendorId = await makeVendor();
    const { billId: invoiceId } = await makeBill(vendorId, { amount: 1200 });
    const { billId: creditId } = await makeBill(vendorId, { amount: 200, creditFor: invoiceId });
    await approveInvoice({ billId: creditId, reviewer: "Priya" });

    const out = await approveInvoice({ billId: invoiceId, reviewer: "Priya" });

    expect(out.payment?.simulated).toBe(true);
    expect((await paymentsFor(invoiceId)).map((p: any) => Number(p.applied_amount))).toEqual([1000]);
    expect(await statusOf(invoiceId)).toBe("paid");
    const trail = await getDecisionsForInvoice(invoiceId);
    expect(trail[trail.length - 1].actionTaken).toBe("paid_less_credit");
    expect(trail[trail.length - 1].claims?.[0].text).toBe("Paid USD 1,000.00: the total less USD 200.00 of credit memos posted against it.");
  });

  it("when credits cover the whole invoice, approving it pays nothing", async () => {
    const vendorId = await makeVendor();
    const { billId: invoiceId } = await makeBill(vendorId, { amount: 500 });
    const { billId: creditId } = await makeBill(vendorId, { amount: 500, creditFor: invoiceId });
    await approveInvoice({ billId: creditId, reviewer: "Priya" });

    const out = await approveInvoice({ billId: invoiceId, reviewer: "Priya" });

    expect(out.payment).toBeUndefined();
    expect(out.noPayment).toBe("covered_by_credit");
    expect(await paymentsFor(invoiceId)).toHaveLength(0);
    expect(await statusOf(invoiceId)).toBe("posted");
  });

  it("an invoice with no credits against it is still paid in full", async () => {
    const vendorId = await makeVendor();
    const { billId } = await makeBill(vendorId, { amount: 640 });
    await postBillApproval(billId);

    const settled = await settleApprovedBill(billId);

    expect(settled).toMatchObject({ kind: "paid", amount: 640, credited: 0 });
    expect((await paymentsFor(billId)).map((p: any) => Number(p.applied_amount))).toEqual([640]);
    expect(await statusOf(billId)).toBe("paid");
  });

  it("the match step counts credits already posted: a second credit no longer fits", async () => {
    const vendorId = await makeVendor();
    const { billId: invoiceId } = await makeBill(vendorId, { amount: 2000 });
    const { billId: firstCredit } = await makeBill(vendorId, { amount: 1500, creditFor: invoiceId });
    await approveInvoice({ billId: firstCredit, reviewer: "Priya" });
    const { billId: secondCredit } = await makeBill(vendorId, { amount: 1000, creditFor: invoiceId, status: "processing" });

    const r = await runMatchStage(secondCredit);

    expect(r.detail.creditMemoNetAmount).toBe(-500);
    expect(r.findings).toEqual([{ code: "EXC-CREDIT_MEMO", action: "escalate_l1", fact: expect.stringContaining("USD 500.00 still open") }]);
  });
});
