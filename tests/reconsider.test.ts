import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getSql } from "@/db/client";
import { runPipeline } from "@/lib/pipeline/orchestrator";
import { getDecision, getDecisionsForInvoice } from "@/lib/ledger/decisions";
import { reconsider, isEscalateSeniorResult } from "@/lib/pipeline/reconsider";

const PREFIX = "TEST-RECON";
const sql = getSql();
const vendorIds: string[] = [];
const billIds: string[] = [];

async function makeVendor(trustTier: "trusted" | "new" | "flagged" = "new") {
  const id = crypto.randomUUID();
  vendorIds.push(id);
  await sql`INSERT INTO vendors (id, name, trust_tier) VALUES (${id}, ${PREFIX + " Vendor " + id.slice(0, 8)}, ${trustTier})`;
  return id;
}

async function makeBill(vendorId: string, invoiceNumber: string, totalAmount: number) {
  const billId = crypto.randomUUID();
  billIds.push(billId);
  await sql`
    INSERT INTO vendor_bills (id, vendor_id, po_id, invoice_number, invoice_date, subtotal, total_amount)
    VALUES (${billId}, ${vendorId}, NULL, ${invoiceNumber}, '2026-08-15', ${totalAmount}, ${totalAmount})`;
  await sql`INSERT INTO vendor_bill_lines (id, vendor_bill_id, description, qty_invoiced, unit_price) VALUES (${crypto.randomUUID()}, ${billId}, 'Consulting services', 1, ${totalAmount})`;
  return billId;
}

afterAll(async () => {
  for (const id of billIds) await sql`DELETE FROM vendor_bill_lines WHERE vendor_bill_id = ${id}`;
  // see tests/orchestrator.test.ts for why this delete-based cleanup is currently safe (empty table pre-test, no ON DELETE CASCADE)
  await sql`DELETE FROM decisions WHERE invoice_id = ANY(${billIds})`;
  await sql`DELETE FROM vendor_bills WHERE id = ANY(${billIds})`;
  await sql`DELETE FROM vendors WHERE id = ANY(${vendorIds})`;
});

describe("reconsider — guard rails (deterministic, no LLM calls)", () => {
  it("refuses to reconsider a deterministic node (match/validate/policy), not just judgment-bearing ones", async () => {
    const vendorId = await makeVendor();
    const billId = await makeBill(vendorId, PREFIX + "-GUARD-1", 500);
    await runPipeline(billId);
    const decisions = await getDecisionsForInvoice(billId);
    const matchDecision = decisions.find((d) => d.nodeId === "match")!;

    await expect(reconsider({ originalDecisionId: matchDecision.id, question: "why?", actor: "tester" }))
      .rejects.toThrow(/deterministic, not judgment-bearing/);
  }, 60_000);

  it("caps at 3 reconsiderations and escalates to a senior reviewer on the 4th attempt, without calling the LLM again", async () => {
    const vendorId = await makeVendor();
    const billId = await makeBill(vendorId, PREFIX + "-CAP-1", 500);
    await runPipeline(billId);
    const decisions = await getDecisionsForInvoice(billId);
    const investigateDecision = decisions.find((d) => d.nodeId === "investigate")!;

    // Simulate 3 prior reconsiderations directly via SQL rather than 3 real LLM round-trips —
    // this test is about the cap's own guard logic, not re-proving the LLM loop works 3 times over.
    for (let i = 0; i < 3; i++) {
      await sql`
        INSERT INTO decisions (id, invoice_id, node_id, reconsideration_of_id, agent_id, started_at, hash)
        VALUES (${crypto.randomUUID()}, ${billId}, 'investigate', ${investigateDecision.id}, 'fake-prior-reconsideration', ${new Date().toISOString()}, ${"fakehash" + i})`;
    }

    const result = await reconsider({ originalDecisionId: investigateDecision.id, question: "look again", actor: "tester" });
    expect(isEscalateSeniorResult(result)).toBe(true);
    if (isEscalateSeniorResult(result)) {
      expect(result.action).toBe("escalate_senior");
    }
  }, 60_000);
});

describe("reconsider — real re-invocation (real LLM calls)", () => {
  it("re-invokes investigate with fresh context plus the human's question, and behaves consistently whether or not it cascades", async () => {
    const vendorId = await makeVendor();
    const billId = await makeBill(vendorId, PREFIX + "-REAL-1", 700);
    await runPipeline(billId);
    const original = (await getDecisionsForInvoice(billId)).find((d) => d.nodeId === "investigate")!;

    const result = await reconsider({
      originalDecisionId: original.id,
      question: "Are you sure this vendor doesn't have a whitelist exemption on file?",
      additionalContext: "Finance flagged this for a second look before approving.",
      actor: "ap-supervisor-jane",
    });

    expect(isEscalateSeniorResult(result)).toBe(false);
    if (isEscalateSeniorResult(result)) return; // type narrowing only; unreachable given the assertion above

    expect(result.newDecision.reconsiderationOfId).toBe(original.id);
    expect(result.newDecision.triggeredByActor).toBe("ap-supervisor-jane");
    expect(result.newDecision.nodeId).toBe("investigate");
    // a genuinely new decision row, not the original one re-returned
    expect(result.newDecision.id).not.toBe(original.id);

    const reFetchedOriginal = await getDecision(original.id);
    if (result.cascaded) {
      expect(result.supersededDecisionIds.length).toBeGreaterThan(0);
      for (const id of result.supersededDecisionIds) {
        const superseded = await getDecision(id);
        expect(superseded?.supersededById).toBe(result.newDecision.id);
      }
    } else {
      expect(result.supersededDecisionIds).toEqual([]);
    }
    // the original decision itself is NEVER edited — append-only, exactly like a normal pipeline run
    expect(reFetchedOriginal?.hash).toBe(original.hash);
  }, 90_000);
});
