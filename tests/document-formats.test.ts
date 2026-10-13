import { describe, it, expect } from "vitest";
import { amountPrintedIn, amountsIn, dateOrderFor, detectCurrency, parseAmount, parseDate } from "@/lib/documents/formats";

describe("amounts as invoices print them", () => {
  it.each([
    ["1,04,135.00", 104135], ["1,377.45", 1377.45], ["₹ 12,434.00", 12434], ["$1,230.90", 1230.9], ["£247.97", 247.97],
    ["Rs. 3,500/-", 3500], ["(45.00)", -45], ["-0.35", -0.35], ["0.34", 0.34], ["12434", 12434], ["4.500", 4.5],
  ])("%s -> %d", (raw, want) => {
    expect(parseAmount(raw)).toBe(want);
  });

  it("refuses what is not one plain number, including European 1.234,56 (it would be read 1000x wrong)", () => {
    for (const raw of ["1.234,56", "abc", "", "12/10/2026", "1,2,3", "18%"]) expect(parseAmount(raw)).toBeNull();
  });

  it("finds every amount on a line, including a trailing-comma one in prose", () => {
    expect(amountsIn("CGST @ 9% 948.33")).toEqual([9, 948.33]);
    expect(amountsIn("1000 nos @ 1.20 = 1,200.00, then 500")).toEqual([1000, 1.2, 1200, 500]);
  });

  it("knows a value is printed whatever its grouping", () => {
    expect(amountPrintedIn(104135, "Total Amount Payable 1,04,135.00")).toBe(true);
    expect(amountPrintedIn(104135, "Total 104,135.00")).toBe(true);
    expect(amountPrintedIn(104135, "Total 104,134.00")).toBe(false);
  });
});

describe("currency", () => {
  it.each([
    ["Total ₹ 12,434.00", "INR"], ["GSTIN 27AAKFS4821M1Z3", "INR"], ["Rs. 3,500", "INR"], ["TOTAL $1,377.45", "USD"],
    ["Invoice Total £297.56", "GBP"], ["Gesamt 120,00 €", "EUR"], ["Amount S$ 45.00", "SGD"], ["Currency: CHF", "CHF"],
  ])("%s -> %s", (text, want) => {
    expect(detectCurrency(text)).toBe(want);
  });

  it("is null when the document does not say (the caller flags it instead of assuming)", () => {
    expect(detectCurrency("Total 1,200.00")).toBeNull();
  });
});

describe("dates", () => {
  it.each([
    ["2026-09-12", null, "2026-09-12"], ["12-Sep-2026", null, "2026-09-12"], ["12 Sep 2026", null, "2026-09-12"],
    ["Sep 12, 2026", null, "2026-09-12"], ["3rd October 2026", null, "2026-10-03"], ["30 September 2026", null, "2026-09-30"],
    ["08.10.2026", "DMY", "2026-10-08"], ["05/10/2026", "DMY", "2026-10-05"], ["10/02/2026", "MDY", "2026-10-02"],
    ["25/10/2026", null, "2026-10-25"], ["11-10-26", "DMY", "2026-10-11"],
  ] as const)("%s (%s) -> %s", (raw, order, want) => {
    expect(parseDate(raw, order)?.iso).toBe(want);
  });

  it("an all-number date that could be either way, with no country to go by, is marked ambiguous (not trusted)", () => {
    expect(parseDate("05/10/2026", null)).toEqual({ iso: "2026-10-05", ambiguous: true });
  });

  it("refuses impossible dates instead of rolling them over", () => {
    expect(parseDate("31-Feb-2026", null)).toBeNull();
    expect(parseDate("2026-13-01", null)).toBeNull();
  });

  it("reads the day/month order from the document's country", () => {
    expect(dateOrderFor("INR")).toBe("DMY");
    expect(dateOrderFor("GBP")).toBe("DMY");
    expect(dateOrderFor("USD")).toBe("MDY");
    expect(dateOrderFor(null, "GSTIN 27AAKFS4821M1Z3")).toBe("DMY");
    expect(dateOrderFor(null)).toBeNull();
  });
});
