import { describe, it, expect } from "vitest";
import { parseLineRow, parseTotalsLine, TABLE_HEADER } from "@/lib/line-rows";

describe("parseLineRow", () => {
  it("reads quantity, unit price and the line amount from a spaced row, with symbols and thousands separators", () => {
    expect(parseLineRow("Industrial Bearing Set 12 $145.00 $1,740.00")).toEqual({ description: "Industrial Bearing Set", quantity: 12, unitPrice: 145 });
  });
  it("reads pipe, comma and tab separated rows", () => {
    expect(parseLineRow("Widget A | 10 | 5.00 | 50.00")).toEqual({ description: "Widget A", quantity: 10, unitPrice: 5 });
    expect(parseLineRow("Consulting, 2, 400.00")).toEqual({ description: "Consulting", quantity: 2, unitPrice: 400 });
    expect(parseLineRow("Kitchen sink\t3\t89.90\t269.70")).toEqual({ description: "Kitchen sink", quantity: 3, unitPrice: 89.9 });
  });
  it("skips a leading row number and a unit word, and keeps digits that belong to the description", () => {
    expect(parseLineRow("1. Zinc Plated Bolt M8x40 200 0.75 150.00")).toEqual({ description: "Zinc Plated Bolt M8x40", quantity: 200, unitPrice: 0.75 });
    expect(parseLineRow("2  Copper pipe 15mm  40 pcs 3.20 128.00")).toEqual({ description: "Copper pipe 15mm", quantity: 40, unitPrice: 3.2 });
    expect(parseLineRow("Pack of 12 units 3 4.50 13.50")).toEqual({ description: "Pack of 12 units", quantity: 3, unitPrice: 4.5 });
  });
  it("accepts a row with only quantity and price (the document totals still have the last word)", () => {
    expect(parseLineRow("Hosting 1 49.00")).toEqual({ description: "Hosting", quantity: 1, unitPrice: 49 });
  });

  it("REFUSES a row whose amount is not quantity x unit price, rather than guess which number is which", () => {
    expect(parseLineRow("Widget A 10 5.00 55.00")).toBeNull();
  });
  it("never reads a totals line, a header, or prose as a row", () => {
    for (const l of ["Subtotal 2,140.00", "Tax (8%) 171.20", "Total $2,311.20", "Grand Total 5 10.00", "Description Qty Unit Price Amount", "Thank you for your business", "", "12 Market Road, Pune"]) {
      expect(parseLineRow(l), l).toBeNull();
    }
  });
  it("rejects zero or negative quantities", () => {
    expect(parseLineRow("Widget 0 5.00 0.00")).toBeNull();
  });
});

describe("parseTotalsLine", () => {
  it("reads colon-less totals, taking the last number on the line", () => {
    expect(parseTotalsLine("Subtotal $2,140.00")).toEqual({ kind: "subtotal", amount: 2140 });
    expect(parseTotalsLine("Tax (8%) $171.20")).toEqual({ kind: "tax", amount: 171.2 });
    expect(parseTotalsLine("Total $2,311.20")).toEqual({ kind: "total", amount: 2311.2 });
    expect(parseTotalsLine("Amount Due 99.00")).toEqual({ kind: "total", amount: 99 });
    expect(parseTotalsLine("GST 18% 180.00")).toEqual({ kind: "tax", amount: 180 });
  });
  it("does not mistake a count for money, or an ordinary line for a total", () => {
    expect(parseTotalsLine("Total Qty 14")).toBeNull();
    expect(parseTotalsLine("Total items 3")).toBeNull();
    expect(parseTotalsLine("Industrial Bearing Set 12 $145.00")).toBeNull();
    expect(parseTotalsLine("Total")).toBeNull();
  });
});

describe("TABLE_HEADER", () => {
  it("recognises the usual header rows and not a row of data", () => {
    for (const h of ["Description Qty Unit Price Amount", "Item  Quantity  Rate  Amount", "# Description Qty Rate", "Sr. No. Particulars Qty Price"]) expect(TABLE_HEADER.test(h), h).toBe(true);
    expect(TABLE_HEADER.test("Industrial Bearing Set 12 $145.00 $1,740.00")).toBe(false);
  });
});
