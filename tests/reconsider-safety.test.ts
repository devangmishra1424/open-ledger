import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Only the LLM-backed investigate stage is replaced. Everything else in reconsider() and the
// orchestrator (match engine, policy, audit, ledger posting, payment) is the real code.
vi.mock("@/lib/pipeline/orchestrator", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/pipeline/orchestrator")>();
  return {
    ...real,
    runInvestigateStage: vi.fn(async (billId: string, _detail: unknown, parentDecisionId?: string, recon?: any) => {
      const { writeDecision } = await import("@/lib/ledger/decisions");
      const now = new Date().toISOString();
      // A model that, asked to look again, confidently recommends approving.
      const decision = await writeDecision({
        invoiceId: billId, nodeId: "investigate", agentId: "stub-model", model: "stub-model", parentDecisionId, startedAt: now, endedAt: now,
        confidence: 0.99, actionTaken: "auto_approve", claims: [{ text: "Looks fine to me", tag: "grounded" }],
        reconsiderationOfId: recon?.reconsiderationOfId, triggeredByActor: recon?.triggeredByActor, triggeredByQuestion: recon?.triggeredByQuestion,
        idempotencyKey: `stub:${billId}:${recon?.attemptTag ?? "first"}`,
      });
      return { decision, submission: { exception_types: [], confidence: 0.99, rationale: "Looks fine to me", recommended_action: "auto_approve" } };
    }),
  };
});

import { getSql } from "@/db/client";
import { writeDecision, getDecisionsForInvoice } from "@/lib/ledger/decisions";
import { reconsider } from "@/lib/pipeline/reconsider";
import { runMatchStage } from "@/lib/pipeline/match-stage";
import { contestInvoice } from "@/lib/ledger/human-review";

const sql = getSql();

/** A no-PO invoice: the deterministic matcher says escalate (EXC-NO_PO), and a prior investigate + policy are on file. */
async function noPoBillWithInvestigation() {
  const vendorId = randomUUID(), billId = randomUUID();
  await sql`INSERT INTO vendors (id, name, trust_tier) VALUES (${vendorId}, ${"RS Vendor " + vendorId.slice(0, 6)}, 'new')`;
  await sql`INSERT INTO vendor_bills (id, vendor_id, invoice_number, invoice_date, subtotal, total_amount, status)
            VALUES (${billId}, ${vendorId}, ${"RS-" + billId.slice(0, 6)}, '2026-10-01', 900, 900, 'exception')`;
  await sql`INSERT INTO vendor_bill_lines (id, vendor_bill_id, description, qty_invoiced, unit_price, gl_account_id) VALUES (${randomUUID()}, ${billId}, 'Consulting', 1, 900, '6000')`;
  const now = new Date().toISOString();
  // What the real matcher concludes is what the policy decision on file says, as in a normal pipeline run.
  const floor = (await runMatchStage(billId)).combined;
  expect(floor.overallAction).not.toBe("auto_approve");
  const investigate = await writeDecision({ invoiceId: billId, nodeId: "investigate", agentId: "stub-model", model: "stub-model", startedAt: now, endedAt: now, confidence: 0.8, actionTaken: floor.overallAction, idempotencyKey: `inv:${billId}` });
  const policy = await writeDecision({ invoiceId: billId, nodeId: "policy", agentId: "deterministic-policy-engine", parentDecisionId: investigate.id, startedAt: now, endedAt: now, actionTaken: floor.overallAction, reasonCode: floor.dominantException ?? undefined, idempotencyKey: `pol:${billId}` });
  return { billId, investigate, policy };
}

describe("reconsideration cannot be talked into moving money", () => {
  it("a re-review that says 'auto_approve' on an invoice the rules flagged changes nothing: no cascade, nothing posted, nothing paid", async () => {
    const { billId, investigate } = await noPoBillWithInvestigation();

    const result = await reconsider({ originalDecisionId: investigate.id, question: "The vendor says the PO number was omitted by mistake", actor: "Sam" });
    if ("action" in result) throw new Error("unexpected escalate_senior");

    expect(result.newDecision.actionTaken).toBe("auto_approve"); // the model did say it, and that is on the record
    expect(result.cascaded).toBe(false); // ...but the deterministic floor (escalate) still stands
    expect((await sql`SELECT status FROM vendor_bills WHERE id = ${billId}`)[0].status).toBe("exception");
    expect(await sql`SELECT 1 FROM journal_entries WHERE source_type = 'vendor_bill' AND source_id = ${billId}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM payment_applications WHERE vendor_bill_id = ${billId}`).toHaveLength(0);
    const live = (await getDecisionsForInvoice(billId)).filter((d) => !d.supersededById);
    expect(live.filter((d) => d.nodeId === "policy")).toHaveLength(1); // no new policy decision was written
  });

  it("through the contest action: the challenge is recorded, the AI re-review runs, and the invoice stays in the queue", async () => {
    const { billId } = await noPoBillWithInvestigation();
    const out = await contestInvoice({ billId, reviewer: "Sam", reason: "The vendor says the PO number was omitted by mistake" });
    expect(out.reconsideration).toMatchObject({ possible: true, escalatedToSenior: false, cascaded: false });
    expect((await sql`SELECT status FROM vendor_bills WHERE id = ${billId}`)[0].status).toBe("exception");
    const decisions = await getDecisionsForInvoice(billId);
    const human = decisions.find((d) => d.nodeId === "human_review")!;
    expect(human.actionTaken).toBe("human_contested");
    expect(human.supersededById).toBeUndefined(); // a person's decision is never superseded by a machine's
  });
});
