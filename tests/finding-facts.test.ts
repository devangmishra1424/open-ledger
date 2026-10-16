import { describe, it, expect } from "vitest";
import * as facts from "@/lib/matching/finding-facts";
import { evaluatePriceVariance, evaluateNonPo, evaluateUnmatchedLine, evaluateBlanketExceeded, evaluateQuantityVariance } from "@/lib/matching/decision-matrix";

/**
 * Each finding's fact sentence names the line, the numbers and the threshold, and ends with the
 * route the engine really chose. Shaped like the demo's real invoices.
 */

describe("finding facts", () => {
  it("price variance: the line, both prices, the percentage, the money at stake, and the real outcome", () => {
    const variancePct = (17710 - 15400) / 15400;
    const action = evaluatePriceVariance(variancePct, 2310);
    const s = facts.priceVarianceFact({ lineNumber: 1, description: "Annual support", uom: "each", billedPrice: 17710, poPrice: 15400, billedQty: 1, variancePct, impact: 2310, currency: "USD", action });
    expect(action).toBe("block");
    expect(s).toContain('PO line 1 "Annual support"');
    expect(s).toContain("billed USD 17,710.00 per each against the order's USD 15,400.00, 15% above it");
    expect(s).toContain("USD 2,310.00 more than agreed");
    expect(s.endsWith("This invoice was blocked.")).toBe(true);
  });

  it("a price below the order is described as below, not as an overcharge", () => {
    const s = facts.priceVarianceFact({ lineNumber: 2, description: "Bolts", uom: "box", billedPrice: 9, poPrice: 10, billedQty: 5, variancePct: 0.1, impact: 5, currency: "USD", action: "block" });
    expect(s).toContain("10% below it");
    expect(s).toContain("USD 5.00 less than agreed");
  });

  it("non-PO: says why (no PO, or a printed PO not on file), the band this amount falls in, and the route", () => {
    const action = evaluateNonPo(2149.2, false);
    const s = facts.nonPoFact({ amount: 2149.2, currency: "USD", printedPoReference: null, trustTier: "new", action });
    expect(s).toContain("refers to no purchase order");
    expect(s).toContain("At USD 2,149.20 it falls in the USD 1,000.01 to 10,000 band");
    expect(s).toContain("vendor trust tier: new");
    expect(s.endsWith("This invoice was sent to a reviewer at level 2.")).toBe(true);
    const printed = facts.nonPoFact({ amount: 50, currency: "USD", printedPoReference: "PO-77", trustTier: "trusted", action: "auto_approve" });
    expect(printed).toContain("prints purchase order PO-77, but no such order is on file");
    expect(printed).toContain("up to USD 100 band");
  });

  it("unmatched lines: lists each line with its arithmetic and the total nobody ordered", () => {
    const lines = [{ description: "Expedite fee", qty: 1, unitPrice: 900, amount: 900 }, { description: "Pallet", qty: 2, unitPrice: 25, amount: 50 }];
    const s = facts.unmatchedLinesFact({ poNumber: "PO-9", lines, total: 950, currency: "USD", action: evaluateUnmatchedLine(950) });
    expect(s).toContain('2 invoice lines are not on purchase order PO-9 at all: "Expedite fee" (1 x USD 900.00 = USD 900.00); "Pallet" (2 x USD 25.00 = USD 50.00)');
    expect(s).toContain("USD 950.00 is billed for things nobody ordered");
    expect(s.endsWith("This invoice was sent to a reviewer.")).toBe(true);
  });

  it("blanket ceiling: this invoice alone, or together with earlier ones, and how far over", () => {
    const alone = facts.blanketValueFact({ poNumber: "PO-2024-1170", ceiling: 10000, prior: 0, current: 12500, currency: "USD", action: evaluateBlanketExceeded(0.25) });
    expect(alone).toContain("This invoice alone (USD 12,500.00) the order reaches USD 12,500.00, USD 2,500.00 (25%) over the ceiling");
    expect(alone.endsWith("This invoice was blocked.")).toBe(true);
    const cumulative = facts.blanketValueFact({ poNumber: "PO-1", ceiling: 10000, prior: 9500, current: 1000, currency: "USD", action: evaluateBlanketExceeded(0.05) });
    expect(cumulative).toContain("Earlier cleared invoices on it total USD 9,500.00; with this one (USD 1,000.00)");
    expect(cumulative.endsWith("This invoice was sent to a reviewer at level 2.")).toBe(true);
  });

  it("quantity: ordered, received in good condition, billed before and now, and the excess's value", () => {
    const action = evaluateQuantityVariance(0.2, 2, 100);
    const s = facts.quantityVarianceFact({ lineNumber: 1, description: "Widget", uom: "each", ordered: 12, acceptedReceived: 10, billedBefore: 0, billedNow: 12, excess: 2, impact: 100, currency: "USD", action });
    expect(s).toContain("ordered 12, received in good condition 10, billed now 12");
    expect(s).toContain("bills 2 each more than has arrived and not yet been billed, worth USD 100.00");
    expect(s).not.toContain("earlier invoices");
  });

  it("before receipt: no delivery at all says how to clear it; a date gap gives both dates", () => {
    expect(facts.beforeReceiptFact({ poNumber: "PO-3", invoiceDate: "2026-10-01", earliestReceipt: null, action: "block" }))
      .toContain("Recording the goods receipt on Orders checks the invoice again on its own. Until then it is blocked.");
    expect(facts.beforeReceiptFact({ poNumber: "PO-3", invoiceDate: "2026-10-01", earliestReceipt: "2026-10-12", gapDays: 11, action: "escalate_l1" }))
      .toContain("dated 2026-10-01, 11 days before the first delivery against purchase order PO-3 (2026-10-12)");
  });

  it("credit memo: whether it fits inside the open invoice", () => {
    expect(facts.creditMemoFact({ credit: 2000, currency: "USD", relatedNumber: "INV-2024-0847", relatedStatus: "paid", openAmount: 0, net: -2000, action: "escalate_l1" }))
      .toContain("against invoice INV-2024-0847, which is already paid, so nothing is left open on it. USD 2,000.00 of the credit is more than is open on that invoice, so a person decides it");
    expect(facts.creditMemoFact({ credit: 200, currency: "USD", relatedNumber: "INV-1", relatedStatus: "posted", openAmount: 1000, net: 800, action: "auto_approve" }))
      .toContain("which has USD 1,000.00 still open. It fits inside the open amount (leaving USD 800.00)");
  });

  it("a clean match says what was compared and found to agree", () => {
    expect(facts.cleanMatchFact({ poNumber: "PO-5", matchedLines: 3, currency: "USD", invoiced: 4500 }))
      .toBe("All 3 invoice lines matched lines on purchase order PO-5: every price is within 2% of the order, nothing is billed beyond what was received in good condition, and no line is outside the order. USD 4,500.00 billed with no exception found.");
  });
});
