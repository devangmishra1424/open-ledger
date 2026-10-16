import { describe, it, expect } from "vitest";
import { getSql } from "@/db/client";
import { ALL_ACTIONS, type Action } from "@/lib/matching/decision-matrix";
import * as facts from "@/lib/matching/finding-facts";
import { REASON_GUIDE, AUTO_APPROVED_GUIDE } from "../frontend/src/lib/reasonGuide";
import { STAGE_GUIDE } from "../frontend/src/lib/stageGuide";
import { actionWords, outcomeWords } from "../frontend/src/lib/labels";
import { routeFor, explainCase, type CaseLike } from "../frontend/src/lib/caseExplain";
import { toFrontendInvoice } from "@/lib/api-shapes";

/**
 * Everything a reviewer (or an interviewer) reads must describe what VeriBook actually does. These
 * phrases name steps it has no screen or code for: contacting the vendor, asking for credit notes or corrected
 * invoices (a credit note that arrives IS entered, on the invoice review screen), coding to an expense account,
 * a whitelist, reviewer roles ("senior reviewer"), recording a unit conversion, part-approving or part-rejecting an invoice, onboarding, teams. (An approved credit memo
 * does come off what is owed: its own invoice while that is unpaid, then the vendor's later invoices.)
 * Phoning the vendor IS a step: the bank-change callback records it and a second person signs off.
 */
const UNDOABLE = /ask the vendor|contact|credit note|corrected invoice|reissue|finance|expense account|\bcod(e|ed|ing) it\b|coding|whitelist|senior|treasury|new callback|record the conversion|conversion, record it|reject the excess|pay what was received|part that was delivered|netted|onboard|\bw-?9\b|e-?mail|fraud review team/i;

function allText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allText);
  if (value && typeof value === "object") return Object.values(value).flatMap(allText);
  return [];
}

describe("on-screen guidance names only steps VeriBook can take", () => {
  it("the reason guide (what it means, what to check, what to do, what the engine does)", () => {
    const offending = allText([REASON_GUIDE, AUTO_APPROVED_GUIDE]).filter((t) => UNDOABLE.test(t));
    expect(offending).toEqual([]);
  });

  it("the stage guide and the route each invoice is on", () => {
    const routes = ALL_ACTIONS.map((a) => routeFor(a));
    const offending = allText([STAGE_GUIDE, routes, ALL_ACTIONS.map(actionWords)]).filter((t) => UNDOABLE.test(t));
    expect(offending).toEqual([]);
  });

  it("the engine's recorded fact sentences, for every route they can end in", () => {
    const sentences = ALL_ACTIONS.flatMap((action: Action) => [
      facts.unmatchedLinesFact({ poNumber: "PO-1", lines: [{ description: "Expedite fee", qty: 1, unitPrice: 40, amount: 40 }], total: 40, currency: "USD", action }),
      facts.uomMismatchFact({ invoiceDescription: "Bolts", invoiceUom: "box", poLineNumber: 1, poDescription: "Bolts", poUom: "each", plausible: true, action }),
      facts.blanketValueFact({ poNumber: "PO-1", ceiling: 10000, prior: 0, current: 10500, currency: "USD", action }),
      facts.blanketQtyFact({ poNumber: "PO-1", ceiling: 100, prior: 0, current: 105, action }),
      facts.currencyFact({ billCurrency: "USD", poCurrency: "USD", poNumber: "PO-1", billRate: 1.02, poRate: 1, ratePct: 0.02, action }),
      facts.nonPoFact({ amount: 6500, currency: "USD", printedPoReference: null, trustTier: "new", action }),
      facts.creditMemoFact({ credit: 2000, currency: "USD", relatedNumber: "INV-1", relatedStatus: "posted", openAmount: 500, net: -1500, action }),
      facts.creditMemoFact({ credit: 2000, currency: "USD", relatedNumber: "INV-1", relatedStatus: "void", openAmount: 0, net: -2000, action }),
      facts.bankChangeFact({ status: "callback_pending", action }),
    ]);
    expect(sentences.filter((t) => UNDOABLE.test(t))).toEqual([]);
  });

  it("the figures shown for each finding: titles, labels, values and rules, for every route", () => {
    const shown = ALL_ACTIONS.flatMap((action: Action) => [
      facts.priceVariance({ lineNumber: 1, description: "Bolts", uom: "each", billedPrice: 11, poPrice: 10, billedQty: 5, variancePct: 0.1, impact: 5, currency: "USD", action }),
      facts.quantityVariance({ lineNumber: 1, description: "Bolts", uom: "each", ordered: 10, acceptedReceived: 8, billedBefore: 2, billedNow: 9, excess: 3, impact: 30, currency: "USD", action }),
      facts.unmatchedLines({ poNumber: "PO-1", lines: [{ description: "Expedite fee", qty: 1, unitPrice: 40, amount: 40 }], total: 40, currency: "USD", action }),
      facts.uomMismatch({ invoiceDescription: "Bolts", invoiceUom: "box", poLineNumber: 1, poDescription: "Bolts", poUom: "each", plausible: false, action }),
      facts.taxVariance({ description: "Bolts", charged: 20, actualRate: 0.2, expectedRate: 0.18, expectedTax: 18, currency: "USD", action, codeName: "18% GST, as printed on the invoice" }),
      facts.blanketValue({ poNumber: "PO-1", ceiling: 10000, prior: 6000, current: 5000, currency: "USD", action }),
      facts.blanketQty({ poNumber: "PO-1", ceiling: 100, prior: 60, current: 50, action }),
      facts.beforeReceipt({ poNumber: "PO-1", invoiceDate: "2026-10-01", earliestReceipt: null, action }),
      facts.beforeReceipt({ poNumber: "PO-1", invoiceDate: "2026-10-01", earliestReceipt: "2026-10-20", gapDays: 19, action }),
      facts.currencyMismatch({ billCurrency: "EUR", poCurrency: "USD", poNumber: "PO-1", billRate: 1, poRate: 1, ratePct: 0, action }),
      facts.nonPo({ amount: 6500, currency: "USD", printedPoReference: "PO-9", trustTier: "new", action }),
      facts.noPo({ poReference: "PO-9", poStatus: "closed", action }),
      facts.creditMemo({ credit: 2000, currency: "USD", relatedNumber: "INV-1", relatedStatus: "paid", openAmount: 0, net: -2000, action }),
      facts.creditMemo({ credit: 2000, currency: "USD", relatedNumber: "INV-1", relatedStatus: "void", openAmount: 0, net: -2000, action }),
      facts.bankChange({ status: "callback_pending", action, oldLast4: "4471", newLast4: "9012", fromThisInvoice: true }),
    ].map((f) => f.shown));
    expect(allText(shown).filter((t) => UNDOABLE.test(t))).toEqual([]);
    // Each one says what is wrong: at least one figure is marked as the wrong part, except an informational fit.
    expect(shown.filter((s) => !s.points.some((p) => p.wrong)).map((s) => s.title)).toEqual([]);
  });

  it("the reason-code names and descriptions the database serves", async () => {
    const rows = await getSql()`SELECT code, name, description FROM reason_codes`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r: any) => UNDOABLE.test(`${r.name} ${r.description}`)).map((r: any) => r.code)).toEqual([]);
  });
});

describe("an AI recommendation written as advice is not shown as an outcome", () => {
  const prose = "Escalate to fraud review team for manual verification and hold payment pending resolution.";

  it("the trail headline says it was free text, without repeating advice the system cannot carry out", () => {
    const headline = outcomeWords({ nodeId: "investigate", actionTaken: prose });
    expect(headline).toBe("Recommended in free text, not one of the system’s routes");
    expect(headline).not.toMatch(/fraud review team/i);
    expect(outcomeWords({ nodeId: "verify", actionTaken: prose })).toBe("Agreed with the first AI");
  });

  it("real routes still read as routes", () => {
    expect(outcomeWords({ nodeId: "investigate", actionTaken: "escalate_l2" })).toBe("Recommended: sent to a reviewer (level 2)");
    expect(outcomeWords({ nodeId: "investigate", actionTaken: "Auto-Approve" })).toBe("Recommended: approved automatically");
    expect(actionWords(prose)).toBe("Free-text advice, not one of the system’s routes");
  });
});

describe("a credit memo is never described as paid", () => {
  // "Nothing is paid" / "never paid out" are the honest sentences; any other "pays" or "paid" about a credit is not.
  const SAYS_PAID = /(?<!nothing |nothing is |never )(pays?|paid)/i;
  const credit: CaseLike = {
    vendor: "Acme Corp", amount: 2000, currency: "USD", poNumber: "Non-PO", state: "needs_attention", invoiceType: "credit_memo",
    reason: { code: "EXC-CREDIT_MEMO", name: "Credit Memo", description: "A credit memo larger than what is still open on the invoice it relates to." },
    decisions: [], threeWay: null, bankChange: null,
    actions: { approve: { allowed: true }, reject: { allowed: true }, contest: { allowed: false, reason: "no AI review" } }, summary: { decidedBy: null },
  };

  it("the Approve and Reject buttons say what happens to a credit", () => {
    const { choices } = explainCase(credit);
    expect(choices.approve).toBe("Posts this credit of $2,000.00 to the ledger: it lowers what you owe Acme Corp, first on its own invoice if that is still open, then on their next approved invoices. Nothing is paid. Your name goes on the record.");
    expect([choices.approve, choices.reject].filter((t) => SAYS_PAID.test(t))).toEqual([]);
    // An ordinary invoice still says it is paid.
    expect(explainCase({ ...credit, invoiceType: "standard" }).choices.approve).toMatch(/then pays it/);
  });

  it("the trail's last step and the headline, once a credit is approved", () => {
    expect(outcomeWords({ nodeId: "audit", actionTaken: "auto_approve" }, { invoiceType: "credit_memo" })).toBe("Credit posted to the ledger; nothing paid");
    expect(outcomeWords({ nodeId: "audit", actionTaken: "no_payment" })).toBe("Posted to the ledger; nothing paid");
    expect(outcomeWords({ nodeId: "audit", actionTaken: "paid_less_credit" })).toBe("Paid, less the vendor’s credit");
    // Only an approval paid in full is recorded as auto_approve (credit changes it: tests/credit-applications.test.ts).
    expect(outcomeWords({ nodeId: "audit", actionTaken: "auto_approve" })).toBe("Posted to the ledger and paid");

    const bill = { id: "cm1", invoice_number: "INV-2024-0847-CM", status: "posted", total_amount: 2000, currency: "USD", invoice_type: "credit_memo",
      received_at: "2026-10-16T09:00:00Z", invoice_date: "2026-10-16", due_date: null };
    const at = "2026-10-16T10:00:00Z";
    const view = (decisions: any[]) => toFrontendInvoice({ bill, vendorName: "Acme Corp", taxId: null, paymentTermsCode: null, poNumber: null, decisions, lines: [], reasons: new Map() });
    const byPerson = view([
      { id: "p", nodeId: "policy", agentId: "engine", actionTaken: "escalate_l1", reasonCode: "EXC-CREDIT_MEMO", hash: "h1", createdAt: at },
      { id: "h", nodeId: "human_review", agentId: "human:Priya", actionTaken: "human_approved", triggeredByActor: "Priya", hash: "h2", createdAt: at },
      { id: "a", nodeId: "audit", agentId: "engine", actionTaken: "no_payment", hash: "h3", createdAt: at },
    ]);
    const auto = view([{ id: "p", nodeId: "policy", agentId: "engine", actionTaken: "auto_approve", reasonCode: "EXC-CREDIT_MEMO", hash: "h1", createdAt: at },
      { id: "a", nodeId: "audit", agentId: "engine", actionTaken: "auto_approve", hash: "h2", createdAt: at }]);

    expect(byPerson.invoiceType).toBe("credit_memo");
    expect(byPerson.summary).toMatchObject({ headline: "Approved by Priya, credit posted to the ledger", detail: "It lowers what you owe Acme Corp. Nothing is paid.", decidedBy: "Priya" });
    expect(auto.summary.headline).toBe("Auto-approved: the credit fits inside what is open on its invoice, credit posted to the ledger");
    expect([byPerson, auto].flatMap((v) => [v.summary.headline, v.summary.detail ?? ""]).filter((t) => SAYS_PAID.test(t))).toEqual([]);
  });

  it("the reason guide tells a reviewer what approving a credit does", () => {
    const usually = REASON_GUIDE["EXC-CREDIT_MEMO"].usually;
    expect(usually).toMatch(/reduction of what you owe the vendor, and nothing is paid/);
    expect(SAYS_PAID.test(usually)).toBe(false);
  });
});
