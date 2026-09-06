import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getSql } from "@/db/client";
import { investigate } from "@/lib/agent/investigator";

/**
 * Real call against the live OpenAI API (gpt-5-nano) AND the live Supabase DB — this is the
 * only way to actually verify the multi-turn loop (function_call -> function_call_output ->
 * next turn -> submit_investigation) works end-to-end, not just that each half type-checks.
 * One well-designed case: a vendor-trust judgment scenario that the Investigator's own
 * system prompt explicitly instructs it to call get_vendor_history for before concluding.
 */

const PREFIX = "TEST-INVESTIGATOR";
const sql = getSql();
let vendorId: string;
let invoiceId: string;

beforeAll(async () => {
  vendorId = crypto.randomUUID();
  await sql`INSERT INTO vendors (id, name, trust_tier) VALUES (${vendorId}, ${PREFIX + " Vendor Co"}, 'flagged')`;
  invoiceId = crypto.randomUUID();
  await sql`
    INSERT INTO vendor_bills (id, vendor_id, invoice_number, invoice_date, subtotal, total_amount)
    VALUES (${invoiceId}, ${vendorId}, ${PREFIX + "-INV-5001"}, '2026-09-01', 15000, 15000)`;
});

afterAll(async () => {
  await sql`DELETE FROM vendor_bills WHERE vendor_id = ${vendorId}`;
  await sql`DELETE FROM vendors WHERE id = ${vendorId}`;
});

describe("investigate() — real multi-turn OpenAI Responses API loop", () => {
  it("gathers real evidence via tool calls before concluding on a flagged-vendor, no-PO high-dollar invoice", async () => {
    const matchResult = {
      exception_types: ["EXC-NON_PO"],
      amount_impact: 15000,
      po_reference: null,
      note: "No PO reference found on this invoice; vendor trust tier and history need review before recommending an action.",
    };

    const result = await investigate(invoiceId, matchResult);

    // Deliberately NOT asserting on which specific evidence tool the model chooses to call —
    // that's the model's own judgment call (this scenario could reasonably draw either
    // get_vendor_history or check_duplicate first, or both), not something this test should
    // pin down. What this test verifies is the plumbing: it actually gathered evidence
    // (more than a single turn) before concluding, and the loop terminated correctly.
    const calledToolNames = result.toolCalls.map((tc) => tc.name);
    expect(calledToolNames.length).toBeGreaterThan(1);
    expect(calledToolNames[calledToolNames.length - 1]).toBe("submit_investigation");
    expect(result.turns).toBeGreaterThan(1);

    expect(result.submission.rationale.length).toBeGreaterThan(0);
    expect(typeof result.submission.confidence).toBe("number");
    expect(result.submission.confidence).toBeGreaterThanOrEqual(0);
    expect(result.submission.confidence).toBeLessThanOrEqual(1);
    expect(Array.isArray(result.submission.exception_types)).toBe(true);

    // every tool call actually hit the real DB and got a real, hashed result back
    for (const tc of result.toolCalls) {
      expect(tc.resultHash).toMatch(/^[0-9a-f]{64}$/);
    }
  }, 60_000);
});
