import { describe, it, expect } from "vitest";
import { explainCase, queueRoute, routeFor, type CaseLike, type DecisionLike } from "../frontend/src/lib/caseExplain";

/**
 * The per-invoice explanation: specific to the invoice it is about, never the generic rule alone.
 * Shapes are the live demo's real invoices (recorded before the engine wrote its own fact sentences,
 * so these also cover working the facts out from the purchase-order comparison).
 */

const d = (nodeId: string, actionTaken: string | null, extra: Partial<DecisionLike> = {}): DecisionLike => ({
  nodeId, actionTaken, reasonCode: null, confidence: null, model: null, claims: [], ...extra,
});
const base = (extra: Partial<CaseLike>): CaseLike => ({
  vendor: "Nexus Dynamics", amount: 17710, currency: "USD", poNumber: "PO-2024-1160", state: "needs_attention",
  reason: null, decisions: [], threeWay: null, bankChange: null,
  actions: { approve: { allowed: true }, reject: { allowed: true }, contest: { allowed: true } }, summary: { decidedBy: null }, ...extra,
});

const nexus = base({
  reason: { code: "EXC-PRICE_VAR", name: "Price Variance", description: "Invoice unit price varies from the PO unit price beyond tolerance." },
  decisions: [
    d("extract", "parsed", { confidence: 100 }), d("validate", "pass", { claims: ["readability: passed", "duplicate: passed"] }),
    d("match", "block", { reasonCode: "EXC-PRICE_VAR", claims: ["EXC-PRICE_VAR: block"] }),
    d("investigate", "auto-approve", { model: "openai/gpt-oss-120b", confidence: 94 }),
    d("verify", "disagreement", { model: "qwen/qwen3.8-27b", confidence: 90 }),
    d("policy", "block", { reasonCode: "EXC-PRICE_VAR", claims: ["Verifier disagreed with the Investigator: ..."] }),
  ],
  threeWay: {
    poNumber: "PO-2024-1160", currency: "USD", poType: "standard", ceiling: null, unmatchedInvoiceLines: [],
    receipts: [{ date: "2026-10-04", condition: "accepted" }], totals: { ordered: 15400, received: 15400, invoiced: 17710 },
    lines: [{ lineNumber: 1, description: "Cloud Edge Hosting Cluster", uom: "each", qtyOrdered: 1, unitPrice: 15400, qtyReceived: 1,
      invoice: { description: "Cloud Edge Hosting Cluster", uom: "each", qty: 1, unitPrice: 17710, amount: 17710 }, priceVariancePct: 0.15, qtyVsReceived: 0, flags: ["price_over"] }],
  },
});

describe("explainCase", () => {
  it("price variance (older record): names the line, both prices, the percentage and the money, worked out from the comparison", () => {
    const x = explainCase(nexus);
    expect(x.found).toEqual([
      'PO line 1 "Cloud Edge Hosting Cluster": billed $17,710.00 per each against the order\'s $15,400.00, 15% above it (2% is tolerated). At the billed quantity of 1 that is $2,310.00 more than agreed.',
    ]);
    expect(x.route?.label).toBe("Blocked");
  });

  it("tells the AI's part honestly: what it recommended, that the second AI disagreed, and that AI cannot loosen the rules", () => {
    const x = explainCase(nexus);
    expect(x.ai[0]).toBe("The AI reviewer (openai/gpt-oss-120b) looked up the vendor's history, duplicates and past corrections, and recommended approving it automatically, reporting itself 94% sure.");
    expect(x.ai[1]).toMatch(/second AI from a different model family \(qwen\/qwen3\.8-27b\) checked it independently and disagreed/);
    expect(x.ai[2]).toMatch(/The AI can only make a decision stricter, never looser, so it cannot approve what the rules flagged/);
  });

  it("prefers the engine's own recorded facts over working them out", () => {
    const fact = 'PO line 1 "Cloud Edge Hosting Cluster": billed USD 17,710.00 per each ... This invoice was blocked.';
    const recorded = { ...nexus, decisions: nexus.decisions.map((x) => (x.nodeId === "match" ? { ...x, claims: ["EXC-PRICE_VAR: block", fact] } : x)) };
    expect(explainCase(recorded).found).toEqual([fact]);
  });

  it("blanket ceiling (older record): the ceiling, this invoice, and how far over it alone goes", () => {
    const x = explainCase(base({
      vendor: "Vertex Materials", amount: 12500, poNumber: "PO-2024-1170",
      reason: { code: "EXC-BLANKET_EXCEEDED", name: "Blanket PO Ceiling Exceeded", description: "..." },
      decisions: [d("match", "block", { claims: ["EXC-BLANKET_EXCEEDED: block"] }), d("policy", "block")],
      threeWay: { ...nexus.threeWay!, poNumber: "PO-2024-1170", poType: "blanket", ceiling: 10000, lines: [] },
    }));
    expect(x.found).toEqual(["Blanket order PO-2024-1170 may be billed up to $10,000.00 in total. This invoice is $12,500.00, which alone is $2,500.00 (25%) over the ceiling."]);
  });

  it("an AI-confidence hold says which limit, and that the invoice itself was clean", () => {
    const x = explainCase(base({
      vendor: "Northwind Parts Ltd.", amount: 2311.2,
      reason: { code: "POLICY_LIMIT", name: "Auto-Approval Limit", description: "..." },
      decisions: [
        d("match", "auto_approve", { reasonCode: "CLEAN_MATCH" }),
        d("investigate", "Escalate to AP reviewer for manual approval due to new vendor risk.", { model: "openai/gpt-oss-120b", confidence: 78 }),
        d("policy", "escalate_l1", { reasonCode: "POLICY_LIMIT", claims: ["Investigator confidence 78% is below the auto-approval threshold of 90%"] }),
      ],
    }));
    expect(x.found[0]).toBe("Investigator confidence 78% is below the auto-approval threshold of 90%. The invoice itself matched its purchase order and delivery cleanly.");
    expect(x.ai[0]).toContain('recommended "Escalate to AP reviewer for manual approval due to new vendor risk", reporting itself 78% sure');
    expect(x.ai).toContain("The rules alone would have approved it. It was held only because of a limit on the Settings page.");
    // The recommendation was prose, not a route the policy step can apply: said plainly, because it did not change anything.
    expect(x.ai[1]).toMatch(/written as free text rather than one of the system.s routes, so it is shown here for the reviewer but could not change the route/);
    expect(x.route?.label).toBe("Reviewer");
  });

  it("a bank change: which accounts, which step it is at, and approve explains what unlocks it", () => {
    const x = explainCase(base({
      vendor: "Meridian Components", amount: 9200, poNumber: "Non-PO",
      reason: { code: "EXC-FRAUD_BANK", name: "Vendor Bank Change", description: "..." },
      decisions: [d("match", "block_fraud_flag", { claims: ["EXC-FRAUD_BANK: block_fraud_flag"] }), d("policy", "block_fraud_flag")],
      bankChange: { step: "start_callback", oldBankLast4: "1234", newBankLast4: "9876" },
    }));
    expect(x.found[0]).toBe("Meridian Components's bank account on file changed from one ending 1234 to one ending 9876. Nobody has phoned the vendor to confirm it yet. This is the most common way invoice fraud works: a convincing request to pay a \"new\" account.");
    expect(x.ai[0]).toMatch(/^No AI looked at this invoice: a rule settled it first/);
    expect(x.choices.approve).toMatch(/Unlocks only after the bank change is verified by phone and a second person signs off/);
    expect(x.route?.label).toBe("Fraud hold");
  });

  it("a failed AI step says so, and that it is the review's fault, not necessarily the invoice's", () => {
    const x = explainCase(base({
      vendor: "Acme Corp", amount: 2000,
      reason: { code: "R99_AGENT_ERROR", name: "Agent error", description: "..." },
      decisions: [
        d("match", "escalate_l1", { claims: ["EXC-CREDIT_MEMO: escalate_l1"] }),
        d("investigate", "error", { claims: ["The AI provider's daily usage limit for openai/gpt-oss-120b was reached; it says to try again in 2m55s."] }),
        d("policy", "escalate_l1"),
      ],
    }));
    expect(x.found[0]).toBe("The AI provider's daily usage limit for openai/gpt-oss-120b was reached; it says to try again in 2m55s. That is a fault in the automated review, not necessarily in the invoice.");
    expect(x.found[1]).toMatch(/^This is a credit of \$2,000\.00 from Acme Corp/);
    expect(x.ai[0]).toMatch(/^The AI reviewer could not finish: The AI provider's daily usage limit/);
  });

  it("a button that is not available says why, in the server's own words", () => {
    const x = explainCase({ ...nexus, actions: { approve: { allowed: true }, reject: { allowed: true }, contest: { allowed: false, reason: "stopped by a deterministic rule before any AI review ran" } } });
    expect(x.choices.contest).toBe("Not available now: stopped by a deterministic rule before any AI review ran.");
    expect(x.choices.approve).toBe("Posts $17,710.00 to the ledger as owed to Nexus Dynamics, then pays it (simulated: no money moves). Your name goes on the record.");
  });

  it("an automatic approval says what was compared and found to agree", () => {
    const x = explainCase({ ...nexus, state: "paid", reason: null, summary: { decidedBy: "system" },
      decisions: [d("match", "auto_approve", { reasonCode: "CLEAN_MATCH" }), d("investigate", "auto_approve", { model: "openai/gpt-oss-120b", confidence: 97 }), d("policy", "auto_approve")],
      threeWay: { ...nexus.threeWay!, lines: [{ ...nexus.threeWay!.lines[0], flags: [] }] } });
    expect(x.route?.label).toBe("Approved automatically");
    expect(x.ai).toEqual([
      "The AI reviewer (openai/gpt-oss-120b) looked up the vendor's history, duplicates and past corrections, and recommended approving it automatically, reporting itself 97% sure.",
      "The rules found nothing wrong and the AI raised no concern the system could act on, so it went through on its own.",
    ]);
    expect(x.found).toEqual(["All 1 invoice line matched lines on purchase order PO-2024-1160: every price is within 2% of the order, nothing is billed beyond what was received in good condition, and no line is outside the order."]);
  });
});

describe("routes", () => {
  it("reads the engine's actions and models' spellings, and nothing else", () => {
    expect(routeFor("escalate_l2")?.label).toBe("Senior reviewer");
    expect(routeFor("Auto-Approve")?.label).toBe("Approved automatically");
    expect(routeFor("Escalate to AP reviewer for manual approval")).toBeNull();
  });

  it("a queued invoice shows what it is waiting on; anything not waiting shows nothing", () => {
    expect(queueRoute({ state: "needs_attention", decisions: [d("policy", "block")], bankChange: null })?.label).toBe("Blocked");
    expect(queueRoute({ state: "paid", decisions: [d("policy", "auto_approve")], bankChange: null })).toBeNull();
  });
});
