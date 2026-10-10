import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { getSql } from "@/db/client";
import { writeDecision, getDecisionsForInvoice, getAllDecisionsInOrder, toChainableRecord } from "@/lib/ledger/decisions";
import { verifyChain } from "@/lib/ledger/hash-chain";
import { approveInvoice, rejectInvoice, contestInvoice, HumanActionError } from "@/lib/ledger/human-review";

/**
 * Human actions through the real database (isolated test schema), no LLM. Rows are left behind
 * deliberately: the test schema is rebuilt from scratch on every run, and deleting decisions out
 * of the middle of the global hash chain is exactly what these tests must never do.
 */

const sql = getSql();
const TAG = "HR-" + randomUUID().slice(0, 6);

async function makeVendor(opts: { bankChangedDaysAgo?: number } = {}) {
  const id = randomUUID();
  const changedAt = opts.bankChangedDaysAgo === undefined ? null : new Date(Date.now() - opts.bankChangedDaysAgo * 86_400_000).toISOString();
  await sql`INSERT INTO vendors (id, name, trust_tier, bank_account_last4, bank_account_changed_at)
            VALUES (${id}, ${TAG + " Vendor " + id.slice(0, 6)}, 'new', '4242', ${changedAt})`;
  return id;
}

/** A bill sitting in the reviewer's queue: status 'exception' with a policy decision explaining why. */
async function makeQueuedBill(vendorId: string, opts: { status?: string; amount?: number } = {}) {
  const billId = randomUUID();
  const amount = opts.amount ?? 1200;
  await sql`INSERT INTO vendor_bills (id, vendor_id, invoice_number, invoice_date, subtotal, total_amount, status)
            VALUES (${billId}, ${vendorId}, ${TAG + "-" + billId.slice(0, 6)}, '2026-10-01', ${amount}, ${amount}, ${opts.status ?? "exception"})`;
  await sql`INSERT INTO vendor_bill_lines (id, vendor_bill_id, description, qty_invoiced, unit_price, gl_account_id)
            VALUES (${randomUUID()}, ${billId}, 'Consulting', 1, ${amount}, '6000')`;
  const now = new Date().toISOString();
  await writeDecision({
    invoiceId: billId, nodeId: "policy", agentId: "deterministic-policy-engine", startedAt: now, endedAt: now,
    actionTaken: "escalate_l1", reasonCode: "EXC-PRICE_VAR", idempotencyKey: `policy:${billId}`,
  });
  return billId;
}

const entriesFor = async (billId: string) => sql`SELECT id FROM journal_entries WHERE source_type = 'vendor_bill' AND source_id = ${billId}`;
const humanDecisions = async (billId: string) => (await getDecisionsForInvoice(billId)).filter((d) => d.nodeId === "human_review");
const statusOf = async (billId: string) => (await sql`SELECT status FROM vendor_bills WHERE id = ${billId}`)[0].status as string;

async function chainIsValid() {
  return verifyChain((await getAllDecisionsInOrder()).map(toChainableRecord));
}

describe("approveInvoice", () => {
  it("posts to the ledger, pays (simulated), and records the approver in the hash chain", async () => {
    const billId = await makeQueuedBill(await makeVendor());
    const out = await approveInvoice({ billId, reviewer: "Priya", note: "Price confirmed with the vendor" });

    expect(out.alreadyDone).toBe(false);
    expect(out.payment?.simulated).toBe(true);
    expect(await statusOf(billId)).toBe("paid");

    const [entry] = await entriesFor(billId);
    const lines = await sql`SELECT debit_amount, credit_amount FROM journal_entry_lines WHERE entry_id = ${entry.id}`;
    const debits = lines.reduce((s: number, l: any) => s + Number(l.debit_amount), 0);
    const credits = lines.reduce((s: number, l: any) => s + Number(l.credit_amount), 0);
    expect(debits).toBeCloseTo(1200, 2);
    expect(credits).toBeCloseTo(1200, 2);

    const [human] = await humanDecisions(billId);
    expect(human.actionTaken).toBe("human_approved");
    expect(human.agentId).toBe("human:Priya");
    expect(human.triggeredByActor).toBe("Priya");
    expect(human.claims?.[0].text).toBe("Price confirmed with the vendor");
    expect(human.reasonCode).toBe("EXC-PRICE_VAR"); // the exception the person resolved
    const decisions = await getDecisionsForInvoice(billId);
    expect(human.parentDecisionId).toBe(decisions.find((d) => d.nodeId === "policy")!.id);

    const review = (await sql`SELECT * FROM reviews WHERE invoice_id = ${billId}`)[0];
    expect(review.action).toBe("approve");
    expect(review.decision_id).toBe(human.id);

    expect((await chainIsValid()).valid).toBe(true);
  });

  it("is a harmless no-op when repeated: no second decision, ledger entry or payment", async () => {
    const billId = await makeQueuedBill(await makeVendor());
    await approveInvoice({ billId, reviewer: "Priya" });
    const again = await approveInvoice({ billId, reviewer: "Priya" });
    expect(again.alreadyDone).toBe(true);
    expect(await humanDecisions(billId)).toHaveLength(1);
    expect(await entriesFor(billId)).toHaveLength(1);
    expect(await sql`SELECT 1 FROM payment_applications WHERE vendor_bill_id = ${billId}`).toHaveLength(1);
  });

  it("refuses while the vendor's bank-detail change is unverified, and moves no money", async () => {
    const billId = await makeQueuedBill(await makeVendor({ bankChangedDaysAgo: 3 }));
    const err = await approveInvoice({ billId, reviewer: "Priya" }).catch((e) => e);
    expect(err).toBeInstanceOf(HumanActionError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/bank details changed and are not verified/);
    expect(await statusOf(billId)).toBe("exception");
    expect(await entriesFor(billId)).toHaveLength(0);
    expect(await humanDecisions(billId)).toHaveLength(0);
  });

  it("refuses a rejected invoice and one that is still processing", async () => {
    const vendorId = await makeVendor();
    const voided = await makeQueuedBill(vendorId, { status: "void" });
    const processing = await makeQueuedBill(vendorId, { status: "processing" });
    await expect(approveInvoice({ billId: voided, reviewer: "Priya" })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/rejected/) });
    await expect(approveInvoice({ billId: processing, reviewer: "Priya" })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/still being processed/) });
  });

  it("404s an unknown invoice", async () => {
    await expect(approveInvoice({ billId: randomUUID(), reviewer: "Priya" })).rejects.toMatchObject({ status: 404 });
  });

  it("rolls back completely when the invoice cannot be posted (no human decision for an approval that did not happen)", async () => {
    const billId = await makeQueuedBill(await makeVendor());
    await sql`UPDATE vendor_bill_lines SET gl_account_id = NULL WHERE vendor_bill_id = ${billId}`; // no GL account, no PO line to fall back to
    const err = await approveInvoice({ billId, reviewer: "Priya" }).catch((e) => e);
    expect(err).toMatchObject({ status: 422, message: expect.stringMatching(/could not post to the ledger/) });
    expect(await statusOf(billId)).toBe("exception");
    expect(await humanDecisions(billId)).toHaveLength(0);
    expect(await sql`SELECT 1 FROM reviews WHERE invoice_id = ${billId}`).toHaveLength(0);
  });
});

describe("rejectInvoice", () => {
  it("voids the invoice, posts nothing, and records who rejected it", async () => {
    const billId = await makeQueuedBill(await makeVendor());
    const out = await rejectInvoice({ billId, reviewer: "Sam", note: "Not our order" });
    expect(out.alreadyDone).toBe(false);
    expect(await statusOf(billId)).toBe("void");
    expect(await entriesFor(billId)).toHaveLength(0);
    const [human] = await humanDecisions(billId);
    expect(human).toMatchObject({ actionTaken: "human_rejected", agentId: "human:Sam" });
    expect(human.claims?.[0].text).toBe("Not our order");
    expect((await chainIsValid()).valid).toBe(true);
  });

  it("is a no-op the second time, and refuses an invoice that is already posted", async () => {
    const vendorId = await makeVendor();
    const a = await makeQueuedBill(vendorId);
    await rejectInvoice({ billId: a, reviewer: "Sam" });
    expect((await rejectInvoice({ billId: a, reviewer: "Sam" })).alreadyDone).toBe(true);
    expect(await humanDecisions(a)).toHaveLength(1);

    const b = await makeQueuedBill(vendorId);
    await approveInvoice({ billId: b, reviewer: "Priya" });
    await expect(rejectInvoice({ billId: b, reviewer: "Sam" })).rejects.toMatchObject({ status: 409 });
  });
});

describe("approve and reject racing on the same invoice", () => {
  it("exactly one wins, and a rejected invoice never reaches the ledger", async () => {
    for (let i = 0; i < 3; i++) {
      const billId = await makeQueuedBill(await makeVendor());
      const results = await Promise.allSettled([
        approveInvoice({ billId, reviewer: "Priya" }),
        rejectInvoice({ billId, reviewer: "Sam" }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const status = await statusOf(billId);
      const entries = await entriesFor(billId);
      if (status === "void") expect(entries).toHaveLength(0);
      else expect(entries).toHaveLength(1);
      expect(await humanDecisions(billId)).toHaveLength(1);
    }
    expect((await chainIsValid()).valid).toBe(true);
  });
});

describe("double-submitting the same approval", () => {
  it("collapses into one decision, one ledger entry and one payment", async () => {
    const billId = await makeQueuedBill(await makeVendor());
    const results = await Promise.allSettled([
      approveInvoice({ billId, reviewer: "Priya" }),
      approveInvoice({ billId, reviewer: "Priya" }),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await humanDecisions(billId)).toHaveLength(1);
    expect(await entriesFor(billId)).toHaveLength(1);
    expect(await sql`SELECT 1 FROM payment_applications WHERE vendor_bill_id = ${billId}`).toHaveLength(1);
  });
});

describe("contestInvoice", () => {
  it("needs a real reason, not a one-word click", async () => {
    const billId = await makeQueuedBill(await makeVendor());
    await expect(contestInvoice({ billId, reviewer: "Sam", reason: "no" })).rejects.toMatchObject({ status: 422 });
    expect(await humanDecisions(billId)).toHaveLength(0);
  });

  it("with nothing for the AI to reconsider, still records the challenge and says why nothing re-ran", async () => {
    const billId = await makeQueuedBill(await makeVendor()); // only a policy decision: stopped by a deterministic rule
    const out = await contestInvoice({ billId, reviewer: "Sam", reason: "The vendor confirmed this price by phone" });
    expect(out.reconsideration).toMatchObject({ possible: false });
    const [human] = await humanDecisions(billId);
    expect(human).toMatchObject({ actionTaken: "human_contested", triggeredByQuestion: "The vendor confirmed this price by phone" });
    expect(await statusOf(billId)).toBe("exception"); // contesting alone changes nothing about the money
  });

  it("is refused once the invoice is posted", async () => {
    const billId = await makeQueuedBill(await makeVendor());
    await approveInvoice({ billId, reviewer: "Priya" });
    await expect(contestInvoice({ billId, reviewer: "Sam", reason: "Actually this looks wrong to me" })).rejects.toMatchObject({ status: 409 });
  });
});
