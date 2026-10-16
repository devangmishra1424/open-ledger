import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getSql } from "@/db/client";
import { writeDecision, getDecisionsForInvoice } from "@/lib/ledger/decisions";
import { postBillApproval } from "@/lib/ledger/journal";
import { triggerPayment, settleApprovedBill } from "@/lib/payments/payments";
import { approveInvoice, rejectInvoice } from "@/lib/ledger/human-review";
import { runAuditStage } from "@/lib/pipeline/orchestrator";

/**
 * An approved credit memo is never paid. Its credit comes off what is owed on the vendor's invoices:
 * its own invoice while that is unpaid, and what is left over off the same vendor's later invoices in
 * the same currency, oldest credit first. Every use is a credit_applications row, so no part of a
 * credit is used twice. Each test has its own vendor, so credit from one test never reaches another.
 * Rows are left behind: the test schema is rebuilt on every run.
 */

const sql = getSql();
const TAG = "CA-" + randomUUID().slice(0, 6);

async function makeVendor() {
  const id = randomUUID();
  await sql`INSERT INTO vendors (id, name, trust_tier) VALUES (${id}, ${TAG + " Vendor " + id.slice(0, 6)}, 'new')`;
  return id;
}

/** A bill waiting on a person (status 'exception') with the policy decision that held it. */
async function makeBill(vendorId: string, opts: { amount: number; creditFor?: string; status?: string; currency?: string; date?: string }) {
  const billId = randomUUID();
  const number = `${TAG}-${billId.slice(0, 6)}${opts.creditFor ? "-CM" : ""}`;
  await sql`INSERT INTO vendor_bills (id, vendor_id, invoice_number, invoice_date, currency, subtotal, total_amount, status, invoice_type, related_invoice_id)
            VALUES (${billId}, ${vendorId}, ${number}, ${opts.date ?? "2026-10-01"}, ${opts.currency ?? "USD"}, ${opts.amount}, ${opts.amount},
                    ${opts.status ?? "exception"}, ${opts.creditFor ? "credit_memo" : "standard"}, ${opts.creditFor ?? null})`;
  await sql`INSERT INTO vendor_bill_lines (id, vendor_bill_id, description, qty_invoiced, unit_price, gl_account_id)
            VALUES (${randomUUID()}, ${billId}, ${opts.creditFor ? "Credit: returned goods" : "Consulting"}, 1, ${opts.amount}, '6000')`;
  const now = new Date().toISOString();
  await writeDecision({
    invoiceId: billId, nodeId: "policy", agentId: "deterministic-policy-engine", startedAt: now, endedAt: now,
    actionTaken: "escalate_l1", reasonCode: opts.creditFor ? "EXC-CREDIT_MEMO" : "EXC-PRICE_VAR", idempotencyKey: `policy:${billId}`,
  });
  return { billId, number };
}

/** A credit memo approved by a person against an invoice already paid in full, so all of it is left over. */
async function leftoverCredit(vendorId: string, amount: number, opts: { currency?: string; date?: string } = {}) {
  const { billId: paidId } = await makeBill(vendorId, { amount: 10000, status: "paid", currency: opts.currency });
  const credit = await makeBill(vendorId, { amount, creditFor: paidId, ...opts });
  await approveInvoice({ billId: credit.billId, reviewer: "Priya" });
  return credit;
}

const approve = (billId: string) => approveInvoice({ billId, reviewer: "Priya" });
/** [credit memo id, amount] for each credit taken off a bill. */
const creditsOn = async (billId: string) =>
  (await sql`SELECT credit_memo_id, applied_amount FROM credit_applications WHERE vendor_bill_id = ${billId} ORDER BY applied_amount`)
    .map((r: any) => [r.credit_memo_id, Number(r.applied_amount)]);
const usedOf = async (creditId: string) =>
  Number((await sql`SELECT COALESCE(SUM(applied_amount), 0) AS used FROM credit_applications WHERE credit_memo_id = ${creditId}`)[0].used);
const paidOn = async (billId: string) =>
  (await sql`SELECT applied_amount FROM payment_applications WHERE vendor_bill_id = ${billId}`).map((r: any) => Number(r.applied_amount));
const statusOf = async (billId: string) => (await sql`SELECT status FROM vendor_bills WHERE id = ${billId}`)[0].status as string;
const lastNote = async (billId: string) => {
  const trail = await getDecisionsForInvoice(billId);
  return trail[trail.length - 1].claims?.[0].text;
};

describe("a credit memo's leftover comes off the vendor's later invoices", () => {
  it("a credit against an invoice already paid comes off the next invoice, and is then used up", async () => {
    const vendorId = await makeVendor();
    const credit = await leftoverCredit(vendorId, 2000);
    expect(await usedOf(credit.billId)).toBe(0);
    expect(await lastNote(credit.billId)).toBe("A credit memo is never paid. Posting it lowered what is owed to the vendor. " +
      "All USD 2,000.00 of it comes off the vendor's next approved invoices in USD.");

    const next = await makeBill(vendorId, { amount: 5000 });
    const out = await approve(next.billId);

    expect(out.payment?.simulated).toBe(true);
    expect(await paidOn(next.billId)).toEqual([3000]);
    expect(await creditsOn(next.billId)).toEqual([[credit.billId, 2000]]);
    expect(await statusOf(next.billId)).toBe("paid");
    expect(await lastNote(next.billId)).toBe(`Paid USD 3,000.00, the total less USD 2,000.00 of the vendor's approved credit, from credit memo ${credit.number}.`);

    const after = await makeBill(vendorId, { amount: 400 });
    await approve(after.billId);
    expect(await paidOn(after.billId)).toEqual([400]);
    expect(await creditsOn(after.billId)).toEqual([]);
    expect(await usedOf(credit.billId)).toBe(2000);
  });

  it("a credit memo is still never paid, however its credit was used", async () => {
    const vendorId = await makeVendor();
    const credit = await leftoverCredit(vendorId, 600);
    await approve((await makeBill(vendorId, { amount: 1000 })).billId);

    expect(await usedOf(credit.billId)).toBe(600);
    expect(await paidOn(credit.billId)).toEqual([]);
    expect(await statusOf(credit.billId)).toBe("posted");
    await expect(triggerPayment(credit.billId, 600)).rejects.toThrow(/credit memo/);
    expect(await settleApprovedBill(credit.billId)).toMatchObject({ kind: "credit_memo", unused: 0 });
    expect(await paidOn(credit.billId)).toEqual([]);
  });

  it("a credit larger than what is open on its own invoice: the open part comes off that invoice, the rest off the next one", async () => {
    const vendorId = await makeVendor();
    const own = await makeBill(vendorId, { amount: 500 });
    const credit = await makeBill(vendorId, { amount: 800, creditFor: own.billId });
    await approve(credit.billId);
    expect(await creditsOn(own.billId)).toEqual([[credit.billId, 500]]);

    const ownOut = await approve(own.billId);
    expect(ownOut.noPayment).toBe("covered_by_credit");
    expect(await paidOn(own.billId)).toEqual([]);

    const next = await makeBill(vendorId, { amount: 1000 });
    await approve(next.billId);
    expect(await paidOn(next.billId)).toEqual([700]);
    expect(await creditsOn(next.billId)).toEqual([[credit.billId, 300]]);
    expect(await settleApprovedBill(credit.billId)).toEqual({
      kind: "credit_memo", unused: 0,
      uses: [{ invoiceNumber: own.number, amount: 500 }, { invoiceNumber: next.number, amount: 300 }],
    });
  });

  it("one credit split across two invoices", async () => {
    const vendorId = await makeVendor();
    const credit = await leftoverCredit(vendorId, 500);

    const first = await makeBill(vendorId, { amount: 300 });
    const firstOut = await approve(first.billId);
    expect(firstOut.noPayment).toBe("covered_by_credit");
    expect(await paidOn(first.billId)).toEqual([]);
    expect(await lastNote(first.billId)).toBe(`USD 300.00 of the vendor's approved credit, from credit memo ${credit.number}, covers all of this invoice. Nothing is paid.`);

    const second = await makeBill(vendorId, { amount: 400 });
    await approve(second.billId);
    expect(await paidOn(second.billId)).toEqual([200]);
    expect(await creditsOn(second.billId)).toEqual([[credit.billId, 200]]);
    expect(await usedOf(credit.billId)).toBe(500);
  });

  it("two credits on one invoice, listed oldest first", async () => {
    const vendorId = await makeVendor();
    const newer = await leftoverCredit(vendorId, 200, { date: "2026-09-20" });
    const older = await leftoverCredit(vendorId, 100, { date: "2026-09-15" });

    const invoice = await makeBill(vendorId, { amount: 1000 });
    await approve(invoice.billId);

    expect(await paidOn(invoice.billId)).toEqual([700]);
    expect(await creditsOn(invoice.billId)).toEqual([[older.billId, 100], [newer.billId, 200]]);
    expect(await lastNote(invoice.billId)).toBe("Paid USD 700.00, the total less USD 300.00 of the vendor's approved credit, " +
      `from credit memos ${older.number} (USD 100.00) and ${newer.number} (USD 200.00).`);
  });

  it("when the credit is more than the invoice, the oldest credit is used first", async () => {
    const vendorId = await makeVendor();
    const newer = await leftoverCredit(vendorId, 200, { date: "2026-09-20" });
    const older = await leftoverCredit(vendorId, 100, { date: "2026-09-15" });

    const invoice = await makeBill(vendorId, { amount: 150 });
    await approve(invoice.billId);

    expect(await creditsOn(invoice.billId)).toEqual([[newer.billId, 50], [older.billId, 100]]);
    expect(await usedOf(older.billId)).toBe(100);
    expect(await usedOf(newer.billId)).toBe(50);
  });

  it("credit in another currency is not used", async () => {
    const vendorId = await makeVendor();
    const euroCredit = await leftoverCredit(vendorId, 300, { currency: "EUR" });

    const dollars = await makeBill(vendorId, { amount: 1000 });
    await approve(dollars.billId);
    expect(await paidOn(dollars.billId)).toEqual([1000]);
    expect(await creditsOn(dollars.billId)).toEqual([]);

    const euros = await makeBill(vendorId, { amount: 1000, currency: "EUR" });
    await approve(euros.billId);
    expect(await paidOn(euros.billId)).toEqual([700]);
    expect(await creditsOn(euros.billId)).toEqual([[euroCredit.billId, 300]]);
  });

  it("invoices settled at the same moment never use the same credit twice", async () => {
    const vendorId = await makeVendor();
    const credit = await leftoverCredit(vendorId, 300);
    const bills = [];
    for (let i = 0; i < 4; i++) {
      const b = await makeBill(vendorId, { amount: 300 });
      await postBillApproval(b.billId);
      bills.push(b);
    }
    // Open enough pooled connections first: a cold pool connects one at a time, so the first settle
    // would finish on the one warm connection before the others even start, and nothing would overlap.
    await Promise.all(Array.from({ length: 12 }, () => sql`SELECT pg_sleep(0.2)`));

    const results = await Promise.all(bills.map((b) => settleApprovedBill(b.billId)));

    expect(await usedOf(credit.billId)).toBe(300);
    expect(results.map((r) => r.kind).sort()).toEqual(["covered_by_credit", "paid", "paid", "paid"]);
    const paid = (await Promise.all(bills.map((b) => paidOn(b.billId)))).flat();
    expect(paid.reduce((s, x) => s + x, 0)).toBe(900);
  });

  it("a later invoice that is rejected uses no credit", async () => {
    const vendorId = await makeVendor();
    const credit = await leftoverCredit(vendorId, 500);
    const rejected = await makeBill(vendorId, { amount: 300 });
    await rejectInvoice({ billId: rejected.billId, reviewer: "Priya" });

    expect(await statusOf(rejected.billId)).toBe("void");
    await expect(settleApprovedBill(rejected.billId)).rejects.toThrow(/rejected/);
    expect(await creditsOn(rejected.billId)).toEqual([]);
    expect(await paidOn(rejected.billId)).toEqual([]);
    expect(await usedOf(credit.billId)).toBe(0);

    const next = await makeBill(vendorId, { amount: 800 });
    await approve(next.billId);
    expect(await paidOn(next.billId)).toEqual([300]);
    expect(await creditsOn(next.billId)).toEqual([[credit.billId, 500]]);
  });

  it("a credit against a rejected invoice, approved by a person, is not taken off that invoice; it comes off the next one", async () => {
    const vendorId = await makeVendor();
    const own = await makeBill(vendorId, { amount: 600 });
    await rejectInvoice({ billId: own.billId, reviewer: "Priya" });
    const credit = await makeBill(vendorId, { amount: 600, creditFor: own.billId });
    await approve(credit.billId);
    expect(await creditsOn(own.billId)).toEqual([]);

    const next = await makeBill(vendorId, { amount: 1000 });
    await approve(next.billId);
    expect(await paidOn(next.billId)).toEqual([400]);
    expect(await creditsOn(next.billId)).toEqual([[credit.billId, 600]]);
  });

  it("re-running the audit stage uses no more credit and pays nothing more", async () => {
    const vendorId = await makeVendor();
    const credit = await leftoverCredit(vendorId, 250);
    const invoice = await makeBill(vendorId, { amount: 1000, status: "processing" });
    const now = new Date().toISOString();
    const policy = await writeDecision({
      invoiceId: invoice.billId, nodeId: "policy", agentId: "deterministic-policy-engine", startedAt: now, endedAt: now,
      actionTaken: "auto_approve", reasonCode: "CLEAN_MATCH", idempotencyKey: `policy-auto:${invoice.billId}`,
    });

    const first = await runAuditStage(invoice.billId, policy);
    const later = await leftoverCredit(vendorId, 100); // more credit arrives before the re-run
    const again = await runAuditStage(invoice.billId, policy);

    expect(again.id).toBe(first.id);
    expect(first.claims?.[0].text).toBe(`Paid USD 750.00, the total less USD 250.00 of the vendor's approved credit, from credit memo ${credit.number}.`);
    expect(await creditsOn(invoice.billId)).toEqual([[credit.billId, 250]]);
    expect(await paidOn(invoice.billId)).toEqual([750]);
    expect(await usedOf(later.billId)).toBe(0);
  });
});

describe("migration 009 records the credit already taken before it", () => {
  it("writes each posted credit's use on its own invoice, and nothing for credit that was never used", async () => {
    const vendorId = await makeVendor();
    // Taken off its invoice's payment: the invoice was paid 800 of 1000.
    const x = await makeBill(vendorId, { amount: 1000 });
    const cx = await makeBill(vendorId, { amount: 200, creditFor: x.billId });
    await approve(cx.billId);
    await approve(x.billId);
    // Its invoice was paid in full first: never used.
    const y = await makeBill(vendorId, { amount: 5000 });
    await approve(y.billId);
    const cy = await makeBill(vendorId, { amount: 2000, creditFor: y.billId });
    await approve(cy.billId);
    // Its invoice is still open: two credits that together are more than it, oldest first.
    const z = await makeBill(vendorId, { amount: 1000 });
    const cz1 = await makeBill(vendorId, { amount: 600, creditFor: z.billId, date: "2026-09-01" });
    const cz2 = await makeBill(vendorId, { amount: 700, creditFor: z.billId, date: "2026-09-02" });
    await approve(cz1.billId);
    await approve(cz2.billId);
    // Marked paid with no payment on file (seeded data): never used.
    const s = await makeBill(vendorId, { amount: 3000, status: "paid" });
    const cs = await makeBill(vendorId, { amount: 100, creditFor: s.billId });
    await approve(cs.billId);

    const credits = [cx, cy, cz1, cz2, cs].map((c) => c.billId);
    const migration = fs.readFileSync(path.join(process.cwd(), "db", "migrations", "009_credit_applications.sql"), "utf-8");
    // Run inside a transaction that is rolled back, so the backfill cannot touch other tests' rows.
    const ROLLBACK = new Error("roll back the migration rehearsal");
    let rows: Array<[string, string, number]> = [];
    await sql.begin(async (tx) => {
      // These credits' rows removed: the database as it was before 009.
      await tx`DELETE FROM credit_applications WHERE credit_memo_id IN ${tx(credits)}`;
      await tx.unsafe(migration);
      await tx.unsafe(migration); // safe to re-run
      rows = (await tx`SELECT credit_memo_id, vendor_bill_id, applied_amount FROM credit_applications WHERE credit_memo_id IN ${tx(credits)} ORDER BY applied_amount`)
        .map((r: any) => [r.credit_memo_id, r.vendor_bill_id, Number(r.applied_amount)]);
      throw ROLLBACK;
    }).catch((e) => { if (e !== ROLLBACK) throw e; }); // only the deliberate rollback is expected here

    expect(rows).toEqual([
      [cx.billId, x.billId, 200],
      [cz2.billId, z.billId, 400],
      [cz1.billId, z.billId, 600],
    ]);
    // The rehearsal left the live rows as they were.
    expect(await creditsOn(z.billId)).toEqual([[cz2.billId, 400], [cz1.billId, 600]]);
  });
});
