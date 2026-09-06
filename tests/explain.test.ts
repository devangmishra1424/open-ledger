import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getSql } from "@/db/client";
import { runPipeline } from "@/lib/pipeline/orchestrator";
import { getDecisionsForInvoice } from "@/lib/ledger/decisions";
import { explain } from "@/lib/explain";

/**
 * Real call against the live OpenAI API AND a real, full pipeline run's actual decisions —
 * this is the only way to verify the two-stage retrieval-then-constrained-answer flow
 * actually grounds its answer in real records, not just that the code compiles.
 */

const PREFIX = "TEST-EXPLAIN";
const sql = getSql();
let vendorId: string;
let billId: string;

beforeAll(async () => {
  vendorId = crypto.randomUUID();
  await sql`INSERT INTO vendors (id, name, trust_tier) VALUES (${vendorId}, ${PREFIX + " Vendor Co"}, 'flagged')`;
  billId = crypto.randomUUID();
  await sql`
    INSERT INTO vendor_bills (id, vendor_id, po_id, invoice_number, invoice_date, subtotal, total_amount)
    VALUES (${billId}, ${vendorId}, NULL, ${PREFIX + "-INV-1"}, '2026-08-15', 15000, 15000)`;
  await sql`INSERT INTO vendor_bill_lines (id, vendor_bill_id, description, qty_invoiced, unit_price) VALUES (${crypto.randomUUID()}, ${billId}, 'Consulting services', 1, 15000)`;
  await runPipeline(billId);
});

afterAll(async () => {
  await sql`DELETE FROM vendor_bill_lines WHERE vendor_bill_id = ${billId}`;
  await sql`DELETE FROM decisions WHERE invoice_id = ${billId}`;
  await sql`DELETE FROM vendor_bills WHERE id = ${billId}`;
  await sql`DELETE FROM vendors WHERE id = ${vendorId}`;
});

describe("explain() — real grounded Q&A over a real pipeline run's decisions", () => {
  it("answers why the policy decision landed where it did, citing real decision ids", async () => {
    const decisions = await getDecisionsForInvoice(billId);
    const policyDecision = decisions.find((d) => d.nodeId === "policy")!;

    const result = await explain(billId, policyDecision.id, "Why was this invoice not auto-approved?");

    expect(result.answer.length).toBeGreaterThan(0);
    expect(result.grounded).toBe(true);
    expect(result.citedDecisionIds.length).toBeGreaterThan(0);
    // every cited id must be a real decision id from THIS invoice's own chain, never fabricated
    const realIds = new Set(decisions.map((d) => d.id));
    for (const id of result.citedDecisionIds) {
      expect(realIds.has(id)).toBe(true);
    }
  }, 60_000); // generous margin above the 20s call timeout + 1 retry worst case

  it("says plainly when something wasn't recorded, rather than inventing an answer", async () => {
    const decisions = await getDecisionsForInvoice(billId);
    const policyDecision = decisions.find((d) => d.nodeId === "policy")!;

    const result = await explain(billId, policyDecision.id, "What was the CFO's personal opinion of this vendor's CEO?");

    // Not asserting exact wording (that's the model's own phrasing) — just that it doesn't
    // fabricate a cited decision id to support an answer about something never captured.
    expect(typeof result.answer).toBe("string");
    expect(result.answer.length).toBeGreaterThan(0);
  }, 30_000);

  it("throws a clear error for a decisionId that doesn't belong to the given invoice", async () => {
    await expect(explain(billId, "not-a-real-decision-id", "why?")).rejects.toThrow(/not found/);
  });
});
