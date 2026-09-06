import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getSql } from "@/db/client";
import { verify } from "@/lib/agent/verifier";

/**
 * Real call against the live TensorMux endpoint (glm-4-7-flash, Chat Completions-compatible)
 * AND the live Supabase DB — verifies the Chat Completions tool-calling loop (assistant
 * tool_calls -> role:"tool" messages -> next turn -> submit_verification) end-to-end.
 */

const PREFIX = "TEST-VERIFIER";
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

describe("verify() — real multi-turn TensorMux Chat Completions loop", () => {
  it("reaches an independent verdict given the same MatchResult and the Investigator's conclusion", async () => {
    const matchResult = { exception_types: ["EXC-NON_PO"], amount_impact: 15000, po_reference: null };
    const investigation = {
      exception_types: ["EXC-NON_PO"],
      confidence: 0.8,
      rationale: "Vendor is flagged and no PO reference exists for a $15,000 invoice; per get_vendor_history, no prior corrections on file.",
      recommended_action: "escalate_l2",
    };

    const result = await verify(invoiceId, matchResult, investigation);

    expect(typeof result.submission.agrees).toBe("boolean");
    expect(result.submission.confidence).toBeGreaterThanOrEqual(0);
    expect(result.submission.confidence).toBeLessThanOrEqual(1);
    expect(Array.isArray(result.submission.exception_types)).toBe(true);
    expect(typeof result.submission.notes).toBe("string");

    const calledToolNames = result.toolCalls.map((tc) => tc.name);
    expect(calledToolNames[calledToolNames.length - 1]).toBe("submit_verification");
    for (const tc of result.toolCalls) {
      expect(tc.resultHash).toMatch(/^[0-9a-f]{64}$/);
    }
  }, 60_000);
});
