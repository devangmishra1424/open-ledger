import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";

/**
 * The Investigator's recommended_action, from the tool schema to the money. It used to be free text,
 * and policy ignored anything that was not exactly an action: on the live demo invoice NW-H22257 the
 * model wrote "Escalate to fraud review team for manual verification and hold payment pending
 * resolution.", and only the Settings confidence limit happened to stop the payment.
 *
 * The model is replaced by a fixed submit_investigation answer (the real one is covered by the live
 * suites); the agent loop, the Investigator, the match engine, policy, audit, posting and payment are
 * the real code, against the test schema.
 */

let submission: Record<string, unknown> = {};
vi.mock("@/lib/agent/llm", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/agent/llm")>();
  return {
    ...real,
    getLlmClient: () => ({
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: {
                role: "assistant", content: null,
                tool_calls: [{ id: "call-1", type: "function", function: { name: "submit_investigation", arguments: JSON.stringify(submission) } }],
              },
            }],
          }),
        },
      },
    }),
  };
});

const { SUBMIT_INVESTIGATION } = await import("@/lib/agent/tools");
const { ALL_ACTIONS } = await import("@/lib/matching/decision-matrix");
const { investigate } = await import("@/lib/agent/investigator");
const { runPipeline } = await import("@/lib/pipeline/orchestrator");
const { getDecisionsForInvoice } = await import("@/lib/ledger/decisions");
const { getSql } = await import("@/db/client");

const sql = getSql();
const FRAUD_PROSE = "Escalate to fraud review team for manual verification and hold payment pending resolution.";
const answer = (recommended_action: unknown) => ({ exception_types: [], confidence: 0.99, rationale: "per get_vendor_history, the bank details changed last week", recommended_action });

/** A clean three-way match: the rules alone would auto-approve and pay it. */
async function cleanBill() {
  const vendorId = randomUUID(), poId = randomUUID(), poLineId = randomUUID(), receiptId = randomUUID(), billId = randomUUID();
  await sql`INSERT INTO vendors (id, name, trust_tier) VALUES (${vendorId}, ${"IR Vendor " + vendorId.slice(0, 6)}, 'trusted')`;
  await sql`INSERT INTO purchase_orders (id, po_number, vendor_id, order_date, status) VALUES (${poId}, ${"IR-PO-" + poId.slice(0, 6)}, ${vendorId}, '2026-09-01', 'open')`;
  await sql`INSERT INTO purchase_order_lines (id, po_id, line_number, description, uom, qty_ordered, unit_price) VALUES (${poLineId}, ${poId}, 1, 'Widget', 'each', 10, 50)`;
  await sql`INSERT INTO goods_receipts (id, po_id, receipt_date, condition) VALUES (${receiptId}, ${poId}, '2026-09-05', 'accepted')`;
  await sql`INSERT INTO goods_receipt_lines (id, goods_receipt_id, po_line_id, qty_received) VALUES (${randomUUID()}, ${receiptId}, ${poLineId}, 10)`;
  await sql`INSERT INTO vendor_bills (id, vendor_id, po_id, invoice_number, invoice_date, subtotal, total_amount)
            VALUES (${billId}, ${vendorId}, ${poId}, ${"IR-" + billId.slice(0, 6)}, '2026-09-10', 500, 500)`;
  await sql`INSERT INTO vendor_bill_lines (id, vendor_bill_id, description, qty_invoiced, unit_price, uom, gl_account_id) VALUES (${randomUUID()}, ${billId}, 'Widget', 10, 50, 'each', '6000')`;
  return billId;
}

describe("submit_investigation's schema", () => {
  it("constrains recommended_action to exactly the six actions, with advice in words in its own field (rationale)", () => {
    const params = SUBMIT_INVESTIGATION.parameters as { properties: Record<string, { type: string; enum?: string[] }>; required: string[] };
    expect([...(params.properties.recommended_action.enum ?? [])].sort()).toEqual([...ALL_ACTIONS].sort());
    expect(params.properties.recommended_action.enum).toHaveLength(6);
    expect(params.properties.rationale).toMatchObject({ type: "string" });
    expect(params.properties.rationale.enum).toBeUndefined();
    expect(params.required).toEqual(expect.arrayContaining(["rationale", "recommended_action"]));
  });
});

describe("investigate() reads the recommendation at the boundary", () => {
  it("stores a spelling variant as the action it names", async () => {
    submission = answer(" Escalate-L2 ");
    expect((await investigate("any-invoice", {})).submission.recommended_action).toBe("escalate_l2");
  });
  it("keeps prose word for word, neither dropped nor mapped to a guessed action", async () => {
    submission = answer(FRAUD_PROSE);
    expect((await investigate("any-invoice", {})).submission.recommended_action).toBe(FRAUD_PROSE);
  });
  it("fails loudly on a missing recommendation instead of treating it as no opinion", async () => {
    submission = { exception_types: [], confidence: 0.99, rationale: "ok" };
    await expect(investigate("any-invoice", {})).rejects.toThrow(/no recommended_action for invoice any-invoice/);
  });
});

describe("runPipeline: a prose recommendation is never silently dropped", () => {
  it("regression (NW-H22257): a clean match whose Investigator wrote prose is held for a person, not posted or paid", async () => {
    const billId = await cleanBill();
    submission = answer(FRAUD_PROSE); // 99% confident, so the Settings confidence limit is not what holds it

    await runPipeline(billId);

    const decisions = await getDecisionsForInvoice(billId);
    expect(decisions.map((d) => d.nodeId)).toEqual(["extract", "validate", "match", "investigate", "policy", "audit"]);
    expect(decisions.find((d) => d.nodeId === "investigate")?.actionTaken).toBe(FRAUD_PROSE); // what the model said, on the record
    const policy = decisions.find((d) => d.nodeId === "policy")!;
    expect(policy).toMatchObject({ actionTaken: "escalate_l1", reasonCode: "INVESTIGATOR_HOLD" });
    expect(policy.claims?.[0].text).toContain(`"${FRAUD_PROSE}"`);

    expect((await sql`SELECT status FROM vendor_bills WHERE id = ${billId}`)[0].status).toBe("exception");
    expect(await sql`SELECT 1 FROM journal_entries WHERE source_type = 'vendor_bill' AND source_id = ${billId}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM payment_applications WHERE vendor_bill_id = ${billId}`).toHaveLength(0);
  });

  it("the same clean match with a recommendation the schema allows is applied as that action", async () => {
    const billId = await cleanBill();
    submission = answer("block_fraud_flag");

    await runPipeline(billId);

    const decisions = await getDecisionsForInvoice(billId);
    expect(decisions.find((d) => d.nodeId === "investigate")?.actionTaken).toBe("block_fraud_flag");
    // block_fraud_flag is not tier-2 eligible (only escalate_l2/block get a second opinion), so no verify row.
    expect(decisions.find((d) => d.nodeId === "policy")).toMatchObject({ actionTaken: "block_fraud_flag", reasonCode: "INVESTIGATOR_HOLD" });
    expect((await sql`SELECT status FROM vendor_bills WHERE id = ${billId}`)[0].status).toBe("exception");
  });
});
