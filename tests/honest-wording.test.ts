import { describe, it, expect } from "vitest";
import { getSql } from "@/db/client";
import { ALL_ACTIONS, type Action } from "@/lib/matching/decision-matrix";
import * as facts from "@/lib/matching/finding-facts";
import { REASON_GUIDE, AUTO_APPROVED_GUIDE } from "../frontend/src/lib/reasonGuide";
import { STAGE_GUIDE } from "../frontend/src/lib/stageGuide";
import { actionWords, outcomeWords } from "../frontend/src/lib/labels";
import { routeFor } from "../frontend/src/lib/caseExplain";

/**
 * Everything a reviewer (or an interviewer) reads must describe what VeriBook actually does. These
 * phrases name steps it has no screen or code for: contacting the vendor, credit notes or corrected
 * invoices, coding to an expense account, a whitelist, reviewer roles ("senior reviewer"), recording a
 * unit conversion, part-approving or part-rejecting an invoice, netting credits, onboarding, teams.
 * Phoning the vendor IS a step: the bank-change callback records it and a second person signs off.
 */
const UNDOABLE = /ask the vendor|contact|credit note|corrected invoice|reissue|finance|expense account|\bcod(e|ed|ing) it\b|coding|whitelist|senior|treasury|new callback|record the conversion|conversion, record it|reject the excess|pay what was received|part that was delivered|netted|net it against|onboard|\bw-?9\b|e-?mail|fraud review team/i;

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
      facts.bankChangeFact({ status: "callback_pending", action }),
    ]);
    expect(sentences.filter((t) => UNDOABLE.test(t))).toEqual([]);
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
