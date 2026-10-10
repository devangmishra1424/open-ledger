import { describe, it, expect } from "vitest";
import { toFrontendInvoice, deriveState, clip, type DecisionInput } from "@/lib/api-shapes";
import type { BankChangeGateCheck } from "@/lib/ledger/bank-change-review";

/** The read model: pure, so every state a screen can be in is checked without a database. */

const reasons = new Map([
  ["EXC-PRICE_VAR", { name: "Price Variance", description: "Invoice unit price varies from the PO unit price beyond tolerance." }],
  ["EXC-NO_PO", { name: "Missing Purchase Order", description: "Invoice has no valid PO reference." }],
]);

let n = 0;
const d = (nodeId: string, extra: Partial<DecisionInput> = {}): DecisionInput => ({
  id: `d${++n}`, nodeId, agentId: nodeId === "human_review" ? "human:Priya" : "engine", hash: `h${n}`, createdAt: `2026-10-08T10:00:0${n % 10}Z`, claims: [], ...extra,
});
const bill = (status: string) => ({ id: "b1", invoice_number: "INV-1001", status, total_amount: 1200, currency: "USD", received_at: "2026-10-08T09:00:00Z", invoice_date: "2026-10-01", due_date: null });
const build = (status: string, decisions: DecisionInput[], extra: Partial<Parameters<typeof toFrontendInvoice>[0]> = {}) =>
  toFrontendInvoice({ bill: bill(status), vendorName: "Acme Corp", taxId: null, paymentTermsCode: "Net 30", poNumber: "PO-1", decisions, lines: [{ description: "x", qtyInvoiced: 2, unitPrice: 600 }], reasons, ...extra });

const pipelineUpToPolicy = (reason: string, action = "escalate_l1") => [
  d("extract", { actionTaken: "parsed", confidence: 1 }), d("validate", { actionTaken: "pass" }), d("match", { actionTaken: action, reasonCode: reason }),
  d("investigate", { actionTaken: "escalate_l1", confidence: 0.9 }), d("policy", { actionTaken: action, reasonCode: reason }),
];

describe("deriveState", () => {
  it("maps statuses to product states, and a posted invoice whose payment failed back to needs_attention", () => {
    expect(deriveState("processing", false)).toBe("processing");
    expect(deriveState("exception", false)).toBe("needs_attention");
    expect(deriveState("void", false)).toBe("rejected");
    expect(deriveState("posted", false)).toBe("approved");
    expect(deriveState("posted", true)).toBe("needs_attention");
    expect(deriveState("paid", false)).toBe("paid");
  });
});

describe("clip", () => {
  it("leaves short text alone, collapses whitespace, and cuts long text at a word with an ellipsis", () => {
    expect(clip("Short enough.")).toBe("Short enough.");
    expect(clip("two   spaces\nand a newline")).toBe("two spaces and a newline");
    const long = "Verifier disagreed with the Investigator: " + "the unit price of 17710 is far above the purchase order price of 15400 and ".repeat(6);
    const out = clip(long, 120)!;
    expect(out.length).toBeLessThanOrEqual(121);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/\s…$/);
    expect(clip(null)).toBeNull();
    expect(clip("")).toBeNull();
  });
});

describe("toFrontendInvoice", () => {
  it("needs_attention: names the exception in plain words and offers approve / reject / contest", () => {
    const v = build("exception", [...pipelineUpToPolicy("EXC-PRICE_VAR")]);
    expect(v.state).toBe("needs_attention");
    expect(v.invoiceNumber).toBe("INV-1001");
    expect(v.summary.headline).toBe("Price Variance");
    expect(v.summary.detail).toMatch(/unit price varies/);
    expect(v.reason?.code).toBe("EXC-PRICE_VAR");
    expect(v.actions.approve.allowed).toBe(true);
    expect(v.actions.reject.allowed).toBe(true);
    expect(v.actions.contest.allowed).toBe(true); // an investigator ran, so there is something to reconsider
    expect(v.progress).toBe(100); // finished processing, even though only 5 of 7 stages ran
    expect(v.status).toBe("In Review");
  });

  it("contest is disabled, with the reason, when a deterministic rule stopped the invoice before any AI ran", () => {
    const v = build("exception", [d("extract", { actionTaken: "parsed" }), d("validate", { actionTaken: "block", reasonCode: "EXC-NO_PO" }), d("policy", { actionTaken: "block", reasonCode: "EXC-NO_PO" })]);
    expect(v.actions.contest).toEqual({ allowed: false, reason: expect.stringMatching(/deterministic rule/) });
    expect(v.actions.approve.allowed).toBe(true);
  });

  it("processing: no actions, progress is stages done out of 7", () => {
    const v = build("processing", [d("extract"), d("validate"), d("match")]);
    expect(v.state).toBe("processing");
    expect(v.progress).toBe(43);
    expect(v.actions.approve).toEqual({ allowed: false, reason: expect.stringMatching(/still being processed/) });
    expect(v.actions.reject.allowed).toBe(false);
  });

  it("on hold for an unverified bank change: say why, name the next step, and refuse approve", () => {
    const gate: BankChangeGateCheck = { gating: true, status: "callback_pending", review: { id: "r1", vendorId: "v", status: "callback_pending", createdAt: "x" } };
    const v = build("exception", pipelineUpToPolicy("EXC-PRICE_VAR"), { gate });
    expect(v.summary.headline).toMatch(/bank details changed/);
    expect(v.actions.approve).toEqual({ allowed: false, reason: expect.stringMatching(/callback check/) });
    expect(v.actions.reject.allowed).toBe(true); // rejecting is always on the safe side
    expect(v.bankChange).toEqual({ reviewId: "r1", status: "callback_pending", step: "start_callback", callbackBy: null, callbackPhone: null, oldBankLast4: null, newBankLast4: null });
    const logged = build("exception", pipelineUpToPolicy("EXC-PRICE_VAR"), { gate: { ...gate, review: { ...gate.review!, callbackAt: "2026-10-08T10:00:00Z" } } });
    expect(logged.bankChange?.step).toBe("record_outcome");
    const confirmed = build("exception", pipelineUpToPolicy("EXC-PRICE_VAR"), { gate: { gating: true, status: "callback_confirmed", review: { ...gate.review!, status: "callback_confirmed" } } });
    expect(confirmed.bankChange?.step).toBe("second_signoff");
    const failed = build("exception", pipelineUpToPolicy("EXC-PRICE_VAR"), { gate: { gating: true, status: "callback_failed", review: { ...gate.review!, status: "callback_failed" } } });
    expect(failed.bankChange?.step).toBe("blocked");
  });

  it("auto-approved and paid: says the system did it, and that the payment was simulated", () => {
    const v = build("paid", [d("extract"), d("validate"), d("match"), d("investigate", { confidence: 0.97 }), d("policy", { actionTaken: "auto_approve", reasonCode: "CLEAN_MATCH" }), d("audit", { actionTaken: "auto_approve" })], { payment: { reference: "SIMULATED-ab12" } });
    expect(v.state).toBe("paid");
    expect(v.summary).toMatchObject({ headline: "Auto-approved: clean three-way match, paid", decidedBy: "system" });
    expect(v.summary.detail).toMatch(/SIMULATED-ab12 \(simulated: no money moved\)/);
    expect(v.payment).toEqual({ reference: "SIMULATED-ab12", simulated: true });
    expect(v.actions.approve).toEqual({ allowed: false, reason: "already approved" });
    expect(v.actions.reject.allowed).toBe(false);
    expect(v.reason).toBeNull();
  });

  it("approved by a person: names them, and lists the human action with their note", () => {
    const v = build("paid", [...pipelineUpToPolicy("EXC-PRICE_VAR"), d("human_review", { actionTaken: "human_approved", triggeredByActor: "Priya", claims: ["Vendor confirmed the price"] }), d("audit", { actionTaken: "auto_approve" })]);
    expect(v.summary.headline).toBe("Approved by Priya, paid");
    expect(v.summary.decidedBy).toBe("Priya");
    expect(v.humanActions).toEqual([{ decisionId: expect.any(String), action: "approve", reviewer: "Priya", note: "Vendor confirmed the price", at: expect.any(String) }]);
    expect(v.decisions.some((x) => x.nodeId === "human_review" && x.label === "Human Review")).toBe(true);
    expect(v.processedByAgents).not.toContain("Human Review"); // the machine pipeline list excludes people
  });

  it("rejected: by a person with their note, or automatically with the rule's name", () => {
    const byHuman = build("void", [...pipelineUpToPolicy("EXC-PRICE_VAR"), d("human_review", { actionTaken: "human_rejected", triggeredByActor: "Sam", claims: ["Not our order"] })]);
    expect(byHuman.summary).toMatchObject({ headline: "Rejected by Sam", detail: "Not our order", decidedBy: "Sam" });
    expect(byHuman.actions.contest.allowed).toBe(true); // a rejection can be contested
    const auto = build("void", [...pipelineUpToPolicy("EXC-NO_PO", "auto_reject")]);
    expect(auto.summary.headline).toBe("Rejected automatically: Missing Purchase Order");
    expect(auto.summary.decidedBy).toBe("system");
  });

  it("posted but the payment failed: surfaced as needing attention, not as done", () => {
    const v = build("posted", [d("extract"), d("policy", { actionTaken: "auto_approve" }), d("audit", { actionTaken: "payment_failed", claims: ["Payment rail unreachable"] })]);
    expect(v.state).toBe("needs_attention");
    expect(v.summary.headline).toBe("Approved, but the payment did not go out");
    expect(v.summary.detail).toBe("Payment rail unreachable");
    expect(v.actions.approve.allowed).toBe(false);
  });

  it("a policy-limit hold shows the specific fact, not just the general rule", () => {
    reasons.set("POLICY_LIMIT", { name: "Auto-Approval Limit", description: "Held for a person because of a Settings limit." });
    const v = build("exception", [d("extract"), d("investigate", { confidence: 0.99 }), d("policy", { actionTaken: "escalate_l1", reasonCode: "POLICY_LIMIT", claims: ["Amount 60000.00 is over the auto-approval limit of 50000.00"] })]);
    expect(v.summary.headline).toBe("Auto-Approval Limit");
    expect(v.summary.detail).toMatch(/60000\.00 is over the auto-approval limit/);
  });

  it("when the SYSTEM failed (not the invoice), the headline says so and carries the real cause", () => {
    reasons.set("R99_AGENT_ERROR", { name: "Agent Error", description: "A pipeline stage failed." });
    const v = build("exception", [d("extract"), d("match", { actionTaken: "escalate_l1", reasonCode: "EXC-CREDIT_MEMO" }), d("investigate", { actionTaken: "error", reasonCode: "R99_AGENT_ERROR", claims: ["Investigator failed: The AI provider's daily usage limit was reached."] }), d("policy", { actionTaken: "block", reasonCode: "R99_AGENT_ERROR" })]);
    expect(v.summary.headline).toBe("The automated review did not finish");
    expect(v.summary.detail).toMatch(/daily usage limit was reached\. A person has to decide, or you can retry/);
    expect(v.actions.contest.allowed).toBe(true);
  });

  it("an older record (a failed AI step, policy reason recorded as CLEAN_MATCH) is still shown as a system failure", () => {
    reasons.set("R99_AGENT_ERROR", { name: "Agent Error", description: "A pipeline stage failed." });
    const v = build("exception", [d("extract"), d("match", { actionTaken: "escalate_l1", reasonCode: "EXC-CREDIT_MEMO" }), d("investigate", { actionTaken: "error", reasonCode: "R99_AGENT_ERROR", claims: ["Investigator failed: timed out"] }), d("policy", { actionTaken: "block", reasonCode: "CLEAN_MATCH" })]);
    expect(v.summary.headline).toBe("The automated review did not finish");
    expect(v.reason?.code).toBe("R99_AGENT_ERROR");
  });

  it("confidence is the mean of what stages reported, or null — never a made-up 100", () => {
    expect(build("exception", [d("extract", { confidence: 1 }), d("investigate", { confidence: 0.8 })]).confidenceScore).toBe(90);
    expect(build("exception", [d("match"), d("policy")]).confidenceScore).toBeNull();
  });

  it("line amounts are rounded to cents and the amount is a number", () => {
    const v = build("exception", [d("extract")]);
    expect(v.items).toEqual([{ description: "x", qty: 2, rate: 600, amount: 1200 }]);
    expect(v.amount).toBe(1200);
  });
});
