import { describe, it, expect } from "vitest";
import {
  descriptionSimilarity,
  matchLinesGreedy,
  matchLinesHungarian,
  matchLines,
  type InvoiceLineInput,
  type PoLineInput,
} from "@/lib/matching/line-match";

function po(overrides: Partial<PoLineInput> & { id: string; lineNumber: number }): PoLineInput {
  return {
    description: "Widget",
    uom: "each",
    qtyOrdered: 100,
    unitPrice: 10,
    ...overrides,
  };
}

function inv(overrides: Partial<InvoiceLineInput> & { id: string }): InvoiceLineInput {
  return {
    description: "Widget",
    uom: "each",
    qty: 100,
    unitPrice: 10,
    ...overrides,
  };
}

describe("descriptionSimilarity (trigram Jaccard)", () => {
  it("identical strings score 1", () => {
    expect(descriptionSimilarity("Steel Widget 4in", "Steel Widget 4in")).toBe(1);
  });
  it("completely different strings score low", () => {
    expect(descriptionSimilarity("Steel Widget", "Office Chair")).toBeLessThan(0.2);
  });
  it("a realistic-length description with a one-character typo still clears the 85% fuzzy-match threshold", () => {
    // Trigram Jaccard is sensitive to string length: a short label loses too large a fraction
    // of its trigrams to a single edit to survive 85% (verified: a 24-char string with one
    // deleted character only scores ~0.79). A realistic invoice-line-length description does.
    expect(descriptionSimilarity(
      "Stainless Steel Hex Bolt M8x40 Zinc Plated",
      "Stainless Steel Hex Bolt M8x40 Zinc Platd",
    )).toBeGreaterThan(0.85);
  });
});

describe("matchLinesGreedy (spec §1.4.1 steps 1-2)", () => {
  it("matches on stated PO line number (primary key) even if descriptions differ", () => {
    const poLines = [po({ id: "po-1", lineNumber: 1, description: "Steel Widget" })];
    const invoiceLines = [inv({ id: "inv-1", statedPoLineNumber: 1, description: "Totally different text" })];
    const r = matchLinesGreedy(invoiceLines, poLines);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].poLineId).toBe("po-1");
    expect(r.matched[0].matchMethod).toBe("exact_line_number");
  });

  it("falls back to fuzzy match when no stated line number is present", () => {
    const poLines = [po({ id: "po-1", lineNumber: 1, description: "Stainless Steel Widget 4in" })];
    const invoiceLines = [inv({ id: "inv-1", description: "Stainless Steel Widget 4in" })];
    const r = matchLinesGreedy(invoiceLines, poLines);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].matchMethod).toBe("fuzzy_description");
  });

  it("falls back to fuzzy match when the stated line number doesn't exist on the PO", () => {
    const poLines = [po({ id: "po-1", lineNumber: 5, description: "Stainless Steel Widget 4in" })];
    const invoiceLines = [inv({ id: "inv-1", statedPoLineNumber: 99, description: "Stainless Steel Widget 4in" })];
    const r = matchLinesGreedy(invoiceLines, poLines);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].matchMethod).toBe("fuzzy_description");
  });

  it("fuzzy fallback requires UoM match even if description is identical", () => {
    const poLines = [po({ id: "po-1", lineNumber: 1, description: "Steel Widget", uom: "box" })];
    const invoiceLines = [inv({ id: "inv-1", description: "Steel Widget", uom: "each" })];
    const r = matchLinesGreedy(invoiceLines, poLines);
    expect(r.matched).toHaveLength(0);
    expect(r.unmatchedInvoiceLines).toEqual([{ invoiceLineId: "inv-1" }]);
  });

  it("fuzzy fallback requires similarity >= 85%, not just any overlap", () => {
    const poLines = [po({ id: "po-1", lineNumber: 1, description: "Steel Widget Bracket Assembly" })];
    const invoiceLines = [inv({ id: "inv-1", description: "Office Chair" })];
    const r = matchLinesGreedy(invoiceLines, poLines);
    expect(r.matched).toHaveLength(0);
  });

  it("picks the highest-similarity candidate when more than one PO line clears the fuzzy threshold", () => {
    const poLines = [
      po({ id: "po-close", lineNumber: 1, description: "Steel Widget 4in Bracket" }),
      po({ id: "po-exact", lineNumber: 2, description: "Steel Widget 4in Bracket Assembly" }),
    ];
    const invoiceLines = [inv({ id: "inv-1", description: "Steel Widget 4in Bracket Assembly" })];
    const r = matchLinesGreedy(invoiceLines, poLines);
    expect(r.matched[0].poLineId).toBe("po-exact");
  });

  it("a matched PO line is removed from the pool so a later invoice line can't re-match it", () => {
    const poLines = [po({ id: "po-1", lineNumber: 1, description: "Steel Widget" })];
    const invoiceLines = [
      inv({ id: "inv-1", statedPoLineNumber: 1, description: "Steel Widget" }),
      inv({ id: "inv-2", statedPoLineNumber: 1, description: "Steel Widget" }),
    ];
    const r = matchLinesGreedy(invoiceLines, poLines);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].invoiceLineId).toBe("inv-1");
    expect(r.unmatchedInvoiceLines).toEqual([{ invoiceLineId: "inv-2" }]);
    expect(r.remainingPoLines).toHaveLength(0);
  });

  it("computes variance zones against the matched PO line's price/qty (spec §1.5)", () => {
    const poLines = [po({ id: "po-1", lineNumber: 1, unitPrice: 45.0, qtyOrdered: 100 })];
    const invoiceLines = [inv({ id: "inv-1", statedPoLineNumber: 1, unitPrice: 47.25, qty: 100 })];
    const r = matchLinesGreedy(invoiceLines, poLines);
    // matches spec's own EXC-03 worked example: $45.00 -> $47.25 is exactly 5.0%, yellow not red
    expect(r.matched[0].priceVariance.zone).toBe("yellow");
    expect(r.matched[0].priceVariance.variancePct).toBeCloseTo(0.05, 5);
    expect(r.matched[0].qtyVariance.zone).toBe("green");
  });

  it("leaves genuinely unmatchable PO lines in remainingPoLines untouched", () => {
    const poLines = [po({ id: "po-1", lineNumber: 1 }), po({ id: "po-2", lineNumber: 2, description: "Office Chair" })];
    const invoiceLines = [inv({ id: "inv-1", statedPoLineNumber: 1 })];
    const r = matchLinesGreedy(invoiceLines, poLines);
    expect(r.remainingPoLines.map((p) => p.id)).toEqual(["po-2"]);
  });
});

describe("matchLinesHungarian (spec §1.7, N:M via min-cost assignment)", () => {
  it("assigns invoice lines to PO lines minimizing total absolute amount difference", () => {
    // inv-A (amount 1000) should pair with po-2 (amount 1000, exact), not po-1 (amount 500)
    const poLines = [po({ id: "po-1", lineNumber: 1, unitPrice: 5, qtyOrdered: 100 }), po({ id: "po-2", lineNumber: 2, unitPrice: 10, qtyOrdered: 100 })];
    const invoiceLines = [inv({ id: "inv-A", unitPrice: 10, qty: 100 }), inv({ id: "inv-B", unitPrice: 5, qty: 100 })];
    const r = matchLinesHungarian(invoiceLines, poLines);
    expect(r.matched).toHaveLength(2);
    const byInv = Object.fromEntries(r.matched.map((m) => [m.invoiceLineId, m.poLineId]));
    expect(byInv["inv-A"]).toBe("po-2");
    expect(byInv["inv-B"]).toBe("po-1");
  });

  it("never assigns across incompatible units of measure, even if it's the only option", () => {
    const poLines = [po({ id: "po-1", lineNumber: 1, uom: "box", unitPrice: 10, qtyOrdered: 100 })];
    const invoiceLines = [inv({ id: "inv-1", uom: "each", unitPrice: 10, qty: 100 })];
    const r = matchLinesHungarian(invoiceLines, poLines);
    expect(r.matched).toHaveLength(0);
    expect(r.unmatchedInvoiceLines).toEqual([{ invoiceLineId: "inv-1" }]);
    expect(r.unmatchedPoLines.map((p) => p.id)).toEqual(["po-1"]);
  });

  it("more invoice lines than PO lines leaves the extra invoice line(s) unmatched", () => {
    const poLines = [po({ id: "po-1", lineNumber: 1, unitPrice: 10, qtyOrdered: 100 })];
    const invoiceLines = [
      inv({ id: "inv-1", unitPrice: 10, qty: 100 }),
      inv({ id: "inv-2", unitPrice: 999, qty: 1 }),
    ];
    const r = matchLinesHungarian(invoiceLines, poLines);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].invoiceLineId).toBe("inv-1");
    expect(r.unmatchedInvoiceLines).toEqual([{ invoiceLineId: "inv-2" }]);
  });

  it("more PO lines than invoice lines leaves the extra PO line(s) unmatched, not force-assigned", () => {
    const poLines = [
      po({ id: "po-1", lineNumber: 1, unitPrice: 10, qtyOrdered: 100 }),
      po({ id: "po-2", lineNumber: 2, unitPrice: 500, qtyOrdered: 1 }),
    ];
    const invoiceLines = [inv({ id: "inv-1", unitPrice: 10, qty: 100 })];
    const r = matchLinesHungarian(invoiceLines, poLines);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].poLineId).toBe("po-1");
    expect(r.unmatchedPoLines.map((p) => p.id)).toEqual(["po-2"]);
  });

  it("empty inputs return everything unmatched without calling into munkres-js", () => {
    const poLines = [po({ id: "po-1", lineNumber: 1 })];
    expect(matchLinesHungarian([], poLines).unmatchedPoLines).toEqual(poLines);
    const invoiceLines = [inv({ id: "inv-1" })];
    expect(matchLinesHungarian(invoiceLines, []).unmatchedInvoiceLines).toEqual([{ invoiceLineId: "inv-1" }]);
  });
});

describe("matchLines (full two-pass pipeline)", () => {
  it("greedy handles the exact-reference line; Hungarian picks up the rest by amount", () => {
    const poLines = [
      po({ id: "po-1", lineNumber: 1, description: "Steel Widget", unitPrice: 10, qtyOrdered: 100 }),
      po({ id: "po-2", lineNumber: 2, description: "Office Chair", unitPrice: 200, qtyOrdered: 5 }),
    ];
    const invoiceLines = [
      inv({ id: "inv-1", statedPoLineNumber: 1, description: "Steel Widget", unitPrice: 10, qty: 100 }),
      inv({ id: "inv-2", description: "Something unrelated entirely", unitPrice: 200, qty: 5 }),
    ];
    const r = matchLines(invoiceLines, poLines);
    expect(r.matched).toHaveLength(2);
    const byInv = Object.fromEntries(r.matched.map((m) => [m.invoiceLineId, m]));
    expect(byInv["inv-1"].matchMethod).toBe("exact_line_number");
    expect(byInv["inv-2"].matchMethod).toBe("hungarian");
    expect(byInv["inv-2"].poLineId).toBe("po-2");
  });

  it("a PO line already consumed by the greedy pass is never offered to the Hungarian pass", () => {
    const poLines = [po({ id: "po-1", lineNumber: 1, unitPrice: 10, qtyOrdered: 100 })];
    const invoiceLines = [
      inv({ id: "inv-1", statedPoLineNumber: 1, unitPrice: 10, qty: 100 }),
      inv({ id: "inv-2", unitPrice: 10, qty: 100 }), // would otherwise also cost-match po-1 perfectly
    ];
    const r = matchLines(invoiceLines, poLines);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].invoiceLineId).toBe("inv-1");
    expect(r.unmatchedInvoiceLines).toEqual([{ invoiceLineId: "inv-2" }]);
  });

  it("clean invoice matching every line auto-clears with no unmatched remainder", () => {
    const poLines = [po({ id: "po-1", lineNumber: 1 })];
    const invoiceLines = [inv({ id: "inv-1", statedPoLineNumber: 1 })];
    const r = matchLines(invoiceLines, poLines);
    expect(r.matched).toHaveLength(1);
    expect(r.unmatchedInvoiceLines).toHaveLength(0);
    expect(r.unmatchedPoLines).toHaveLength(0);
  });
});
