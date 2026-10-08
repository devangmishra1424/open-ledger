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
