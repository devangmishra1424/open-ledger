import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { getSql } from "@/db/client";
import { guardrailBreach, getPolicyLimits, DEFAULT_POLICY_LIMITS } from "@/lib/settings";
import { evaluatePolicy, computePolicyAction } from "@/lib/pipeline/orchestrator";
import { asAction, type CombinedDecision } from "@/lib/matching/decision-matrix";
import { GET as getSettings, PUT as putSettings } from "@/app/api/settings/route";

const sql = getSql();
const clean: CombinedDecision = { overallAction: "auto_approve", dominantException: null, cascaded: false, deferredExceptions: [] };

async function billOf(amount: number) {
  const vendorId = randomUUID(), billId = randomUUID();
  await sql`INSERT INTO vendors (id, name, trust_tier) VALUES (${vendorId}, ${"SET Vendor " + vendorId.slice(0, 6)}, 'trusted')`;
  await sql`INSERT INTO vendor_bills (id, vendor_id, invoice_number, invoice_date, subtotal, total_amount)
            VALUES (${billId}, ${vendorId}, ${"SET-" + billId.slice(0, 6)}, '2026-10-01', ${amount}, ${amount})`;
  return billId;
}

describe("guardrailBreach (pure)", () => {
  const limits = { autoApprovalConfidence: 95, maxAutoPaymentAmount: 10_000 };
  it("lets a small, confident auto-approval stand", () => {
    expect(guardrailBreach({ amount: 500, investigatorConfidence: 0.97 }, limits)).toBeNull();
  });
  it("stops an amount over the limit, with the numbers in the message", () => {
    expect(guardrailBreach({ amount: 10_000.01, investigatorConfidence: 0.99 }, limits)).toMatch(/10000\.01 is over the auto-approval limit of 10000\.00/);
  });
  it("treats the limit itself as allowed", () => {
    expect(guardrailBreach({ amount: 10_000, investigatorConfidence: 0.99 }, limits)).toBeNull();
  });
  it("stops low investigator confidence", () => {
    expect(guardrailBreach({ amount: 500, investigatorConfidence: 0.9 }, limits)).toMatch(/90% is below the auto-approval threshold of 95%/);
  });
  it("does not invent a confidence check when no investigation reported one", () => {
    expect(guardrailBreach({ amount: 500 }, limits)).toBeNull();
  });
});

describe("evaluatePolicy applies the guardrails to auto-approvals only", () => {
  it("a clean match above the amount limit becomes a human review with its own reason code", async () => {
    await putSettings(new Request("http://t/x", { method: "PUT", body: JSON.stringify({ maxAutoPaymentAmount: 1000, autoApprovalConfidence: 90 }) }), undefined as never);
    const over = await evaluatePolicy(await billOf(1500), clean, undefined, 0.99);
    expect(over.action).toBe("escalate_l1");
    expect(over.reasonCode).toBe("POLICY_LIMIT");
    expect(over.claims[0].text).toMatch(/over the auto-approval limit/);
    const under = await evaluatePolicy(await billOf(900), clean, undefined, 0.99);
    expect(under).toMatchObject({ action: "auto_approve", reasonCode: "CLEAN_MATCH" });
    const unsure = await evaluatePolicy(await billOf(900), clean, undefined, 0.8);
    expect(unsure).toMatchObject({ action: "escalate_l1", reasonCode: "POLICY_LIMIT" });
  });

  it("never loosens: a block stays a block however generous the limits", async () => {
    await putSettings(new Request("http://t/x", { method: "PUT", body: JSON.stringify({ maxAutoPaymentAmount: 1e9, autoApprovalConfidence: 0 }) }), undefined as never);
    const blocked: CombinedDecision = { overallAction: "block", dominantException: "EXC-NO_PO", cascaded: false, deferredExceptions: [] };
    expect(await evaluatePolicy(await billOf(10), blocked, undefined, 1)).toMatchObject({ action: "block", reasonCode: "EXC-NO_PO" });
  });
});

describe("computePolicyAction (pure)", () => {
  it("a disagreeing Verifier raises an auto-approval to at least escalate_l2", () => {
    const r = computePolicyAction(clean, { agrees: false, exception_types: [], confidence: 0.4, notes: "price looks off" });
    expect(r.action).toBe("escalate_l2");
    expect(r.claims[0].text).toMatch(/Verifier disagreed.*price looks off/);
  });
  it("an agreeing Verifier changes nothing", () => {
    expect(computePolicyAction(clean, { agrees: true, exception_types: [], confidence: 0.9, notes: "" }).action).toBe("auto_approve");
  });
});

describe("the Investigator's recommendation can only tighten the outcome", () => {
  const priceVariance: CombinedDecision = { overallAction: "escalate_l1", dominantException: "EXC-PRICE_VAR", cascaded: false, deferredExceptions: [] };
  const blockedQty: CombinedDecision = { overallAction: "block", dominantException: "EXC-QTY_VAR", cascaded: false, deferredExceptions: [] };

  it("regression: a clean match the Investigator wants escalated is no longer auto-approved", () => {
    // Before, the recommendation was stored and never applied: this came out auto_approve and was paid.
    const r = computePolicyAction(clean, undefined, "escalate_l1");
    expect(r.action).toBe("escalate_l1");
    expect(r.heldByInvestigator).toBe(true);
    expect(r.claims[0].text).toMatch(/Investigator recommended escalate_l1, stricter than the rules' auto_approve/);
  });
  it("cannot loosen: an 'auto_approve' recommendation leaves an escalation or a block exactly as the rules decided", () => {
    expect(computePolicyAction(priceVariance, undefined, "auto_approve")).toMatchObject({ action: "escalate_l1", heldByInvestigator: false });
    expect(computePolicyAction(blockedQty, undefined, "escalate_l1")).toMatchObject({ action: "block", heldByInvestigator: false });
  });
  it("may raise an existing exception further (an escalation to a block)", () => {
    expect(computePolicyAction(priceVariance, undefined, "block").action).toBe("block");
  });
  it("an AI 'reject' is held for a person (block), never turned into a void on its own", () => {
    expect(computePolicyAction(clean, undefined, "auto_reject").action).toBe("block");
  });
  it("reads spelling variants a model really writes; no Investigator means no recommendation to apply", () => {
    expect(computePolicyAction(clean, undefined, "Escalate-L2").action).toBe("escalate_l2");
    expect(computePolicyAction(clean, undefined, undefined)).toMatchObject({ action: "auto_approve", heldByInvestigator: false, claims: [] });
    expect(computePolicyAction(clean, undefined, null)).toMatchObject({ action: "auto_approve", heldByInvestigator: false, claims: [] });
  });

  // Regression: the live demo invoice NW-H22257. Text that is not an action used to be ignored, so a
  // clean match came out auto_approve and only the Settings confidence limit happened to stop it.
  const fraudProse = "Escalate to fraud review team for manual verification and hold payment pending resolution.";
  it("a prose recommendation is not dropped: a clean match is held for a person, and the hold is on the record", () => {
    const r = computePolicyAction(clean, undefined, fraudProse);
    expect(r).toMatchObject({ action: "escalate_l1", heldByInvestigator: true });
    expect(r.claims[0].text).toMatch(/not one of the actions.*free-text advice.*held for a person \(escalate_l1, stricter than the rules' auto_approve\)/);
  });
  it("the advice itself is not repeated in the policy record: it names steps the system cannot carry out", () => {
    const r = computePolicyAction(clean, undefined, fraudProse);
    expect(r.claims[0].text).not.toContain("fraud review team");
  });
  it("prose that sounds like an approval is not guessed at either: it is held, never read as auto_approve", () => {
    expect(computePolicyAction(clean, undefined, "Approve the invoice for payment.")).toMatchObject({ action: "escalate_l1", heldByInvestigator: true });
    expect(computePolicyAction(clean, undefined, "hold for review")).toMatchObject({ action: "escalate_l1", heldByInvestigator: true });
    expect(computePolicyAction(clean, undefined, "")).toMatchObject({ action: "escalate_l1", heldByInvestigator: true });
  });
  it("prose cannot loosen a stricter rule outcome, and is still recorded as not applied", () => {
    const r = computePolicyAction(blockedQty, undefined, "Approve the invoice for payment.");
    expect(r).toMatchObject({ action: "block", heldByInvestigator: false });
    expect(r.claims[0].text).toMatch(/free-text advice\. The rules' block is already at least as strict/);
  });
  it("evaluatePolicy holds a clean match with prose as INVESTIGATOR_HOLD however generous the Settings limits", async () => {
    await putSettings(new Request("http://t/x", { method: "PUT", body: JSON.stringify({ maxAutoPaymentAmount: 1e9, autoApprovalConfidence: 0 }) }), undefined as never);
    expect(await evaluatePolicy(await billOf(900), clean, undefined, 0.99, fraudProse)).toMatchObject({ action: "escalate_l1", reasonCode: "INVESTIGATOR_HOLD" });
  });
  it("a disagreeing Verifier still applies on top of the Investigator's hold", () => {
    expect(computePolicyAction(clean, { agrees: false, exception_types: [], confidence: 0.5, notes: "x" }, "escalate_l1").action).toBe("escalate_l2");
  });
  it("evaluatePolicy names the hold: INVESTIGATOR_HOLD on a clean match, the real exception otherwise", async () => {
    expect(await evaluatePolicy(await billOf(900), clean, undefined, 0.97, "escalate_l1")).toMatchObject({ action: "escalate_l1", reasonCode: "INVESTIGATOR_HOLD" });
    expect(await evaluatePolicy(await billOf(900), priceVariance, undefined, 0.97, "block")).toMatchObject({ action: "block", reasonCode: "EXC-PRICE_VAR" });
    expect(await evaluatePolicy(await billOf(900), clean, undefined, 0.97, "auto_approve")).toMatchObject({ action: "auto_approve", reasonCode: "CLEAN_MATCH" });
  });
});

describe("asAction", () => {
  it("accepts only real actions and never casts free text", () => {
    expect(asAction("escalate_l2")).toBe("escalate_l2");
    expect(asAction("approve")).toBeUndefined();
    expect(asAction("auto‑approve")).toBeUndefined(); // non-breaking hyphen, as a model really produced
    expect(asAction(undefined)).toBeUndefined();
  });
});

describe("settings API", () => {
  const put = (body: unknown) => putSettings(new Request("http://t/x", { method: "PUT", body: JSON.stringify(body) }), undefined as never);
  it("validates ranges and requires at least one value", async () => {
    expect((await put({ autoApprovalConfidence: 101 })).status).toBe(400);
    expect((await put({ maxAutoPaymentAmount: -1 })).status).toBe(400);
    expect((await put({ autoApprovalConfidence: "high" })).status).toBe(400);
    expect((await put({})).status).toBe(400);
  });
  it("persists a partial update and GET reports what the policy engine will actually use", async () => {
    await put({ autoApprovalConfidence: 80, maxAutoPaymentAmount: 2500 });
    await put({ maxAutoPaymentAmount: 7000 }); // does not touch the confidence
    const body = await (await getSettings(new Request("http://t/x"), undefined as never)).json();
    expect(body).toEqual({ autoApprovalConfidence: 80, maxAutoPaymentAmount: 7000 });
    expect(await getPolicyLimits()).toEqual(body);
    await put({ autoApprovalConfidence: DEFAULT_POLICY_LIMITS.autoApprovalConfidence, maxAutoPaymentAmount: DEFAULT_POLICY_LIMITS.maxAutoPaymentAmount });
  });
});
