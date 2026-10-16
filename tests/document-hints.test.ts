import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { bankAccountLast4, isCreditNote, spendingLimit } from "@/lib/documents/hints";
import { documentText, rowsFromReading } from "@/lib/documents/layout";
import { spreadTax, statedTaxRate } from "@/lib/tax-lines";

/** What a document says that the books need: a credit note, the bank account, a PO's spending limit, a printed tax rate. */

const readings = () => {
  const dir = path.join(process.cwd(), "eval", "documents", "readings");
  return fs.readdirSync(dir).map((f) => documentText(rowsFromReading(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))));
};

describe("a credit note is told by its heading", () => {
  it("a heading that says credit note or credit memo", () => {
    expect(isCreditNote("CREDIT NOTE\nAcme Corp\nCredit Note No: CN-77\nAgainst invoice INV-2024-0847")).toBe(true);
    expect(isCreditNote("Acme Corp | Tax Credit Memo\nDate: 2026-10-01")).toBe(true);
  });

  it("not an invoice that mentions one in its terms, nor any of the sample invoices", () => {
    expect(isCreditNote("TAX INVOICE\nTerms: a credit note will be issued for returned goods")).toBe(false);
    expect(readings().filter(isCreditNote)).toEqual([]);
  });
});

describe("the bank account an invoice asks to be paid into: its last 4 digits only", () => {
  it("reads the account on a line about a bank, in the forms invoices print it", () => {
    expect(bankAccountLast4("Kindly remit to: ICICI Bank, Lajpat Nagar branch, A/c No. 004105012345, IFSC ICIC0000041.")).toBe("2345");
    expect(bankAccountLast4("Bank: Barclays, Sort Code 20-45-77, Account 43918822.")).toBe("8822");
    expect(bankAccountLast4("Remit to: Chase Bank\nAccount Number: 9876-5432-10")).toBe("3210");
    expect(bankAccountLast4("IBAN: GB29 NWBK 6016 1331 9268 19")).toBe("6819");
  });

  it("not a customer account, a short number, or an account with no bank context", () => {
    expect(bankAccountLast4("Customer Account No: 55512345\nBank: see below")).toBeNull();
    expect(bankAccountLast4("Bank: HDFC, A/c 1234")).toBeNull();
    expect(bankAccountLast4("Account manager: Priya, account 99887766")).toBeNull();
  });

  it("each sample invoice that prints one gives the same account every time it is read", () => {
    const found = new Set(readings().map(bankAccountLast4).filter(Boolean));
    expect([...found].sort()).toEqual(["1234", "2345", "8822"]);
  });
});

describe("a purchase order's spending limit", () => {
  it("is read from 'not to exceed' and similar lines", () => {
    expect(spendingLimit("PURCHASE ORDER (BLANKET)\nNot to exceed: $10,000.00")).toBe(10000);
    expect(spendingLimit("Blanket order limit INR 5,00,000")).toBe(500000);
    expect(spendingLimit("Maximum order value: USD 2,500")).toBe(2500);
  });

  it("is not taken from an item that happens to say ceiling, or from a PO that states none", () => {
    expect(spendingLimit("1. Gypsum ceiling board 20 sheets 450.00")).toBeNull();
    expect(spendingLimit("PURCHASE ORDER\nPO Number: PO-1\n1. Bearing Qty 12 Unit Price 145.00")).toBeNull();
  });
});

describe("the tax rate printed on an invoice", () => {
  it("adds up the rates on its tax lines and names it for the record", () => {
    expect(statedTaxRate([{ label: "CGST @ 9%", amount: 900 }, { label: "SGST @ 9%", amount: 900 }])).toEqual({ rate: 0.18, type: "gst", name: "18% GST, as printed on the invoice" });
    expect(statedTaxRate([{ label: "Sales Tax 8.25%", amount: 101.55 }])).toMatchObject({ rate: 0.0825, type: "sales_tax" });
    expect(statedTaxRate([{ label: "IGST18 (18%)", amount: 10980 }])?.rate).toBe(0.18);
  });

  it("gives nothing to compare when a tax line prints no rate, or there is no tax", () => {
    expect(statedTaxRate([{ label: "CGST @ 9%", amount: 900 }, { label: "SGST", amount: 900 }])).toBeNull();
    expect(statedTaxRate([])).toBeNull();
  });

  it("spreads the tax over the lines by amount, and the shares add up to what was charged", () => {
    const shares = spreadTax({ charged: 1896.66, items: [5000, 3537, 2000], charges: [], discount: 0, rate: 0.18 })!;
    expect(shares).toEqual([900, 636.66, 360]);
    expect(Math.round(shares.reduce((s, x) => s + x, 0) * 100) / 100).toBe(1896.66);
  });

  it("taxes shipping only when the printed rate fits items and shipping together", () => {
    // The US sample: 8.25% on the items only; shipping untaxed.
    expect(spreadTax({ charged: 101.55, items: [1230.9], charges: [45], discount: 0, rate: 0.0825 })).toEqual([101.55, 0]);
    // 10% charged on items and shipping together.
    expect(spreadTax({ charged: 110, items: [1000], charges: [100], discount: 0, rate: 0.1 })).toEqual([100, 10]);
  });

  it("sets up no check when an invoice-level discount is what explains the tax: the line check could not see it", () => {
    expect(spreadTax({ charged: 162, items: [1000], charges: [], discount: 100, rate: 0.18 })).toBeNull();
  });

  it("every sample invoice's tax fits the rate it prints (so none would be flagged)", async () => {
    const { extractInvoice } = await import("@/lib/documents/invoice");
    const dir = path.join(process.cwd(), "eval", "documents", "readings");
    let checked = 0;
    for (const f of fs.readdirSync(dir)) {
      const x = await extractInvoice(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")), { llm: false });
      const s = x.submission;
      const stated = statedTaxRate(s.tax_lines ?? []);
      // Only readings whose figures add up: a person corrects a misread scan before it can be saved.
      if (!stated || !x.checks.every((c) => c.passed)) continue;
      const items = s.line_items.map((l) => l.amount ?? l.quantity * l.unit_price);
      const tax = (s.tax_lines ?? []).reduce((a, t) => a + t.amount, 0);
      const shares = spreadTax({ charged: tax, items, charges: (s.other_charges ?? []).map((c) => c.amount), discount: s.discount ?? 0, rate: stated.rate });
      for (const [i, share] of (shares ?? []).entries()) {
        if (i < items.length && share > 0) expect(Math.abs(share / items[i] - stated.rate)).toBeLessThanOrEqual(0.005);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });
});
