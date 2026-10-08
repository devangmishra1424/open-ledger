import { describe, it, expect, vi, afterEach } from "vitest";
import { extract, parseTemplateInvoice, assessExtraction, normalizeDate } from "@/lib/agent/extractor";
import { liveLlm } from "./helpers/live-llm";

const INLINE_INVOICE = `
INVOICE
Acme Supply Co.
Invoice #: INV-77021
Date: 2026-08-15
PO Reference: PO-2026-0042

Line Items:
1. Steel Widget Bracket - Qty 50 - Unit Price $12.00
2. Zinc Plated Bolt M8x40 - Qty 200 - Unit Price $0.75

Subtotal: $750.00
Tax: $60.00
Total: $810.00
Currency: USD
`.trim();

const BLOCK_INVOICE = `
Acme Cloud Services
INVOICE
Invoice Number: INV-ACS-1001
Invoice Date: 2026-09-10
Purchase Order: PO-2026-1001

Line Items:
1. Cloud GPU Compute Cluster (A100)
   Qty: 4
   Unit Price: $2,500.00
---
Total Amount Due: $10,000.00
`.trim();

afterEach(() => vi.unstubAllEnvs());

describe("parseTemplateInvoice", () => {
  it("reads the inline one-line-per-item layout", () => {
    const s = parseTemplateInvoice(INLINE_INVOICE);
    expect(s.vendor_name).toBe("Acme Supply Co.");
    expect(s.invoice_number).toBe("INV-77021");
    expect(s.invoice_date).toBe("2026-08-15");
    expect(s.po_reference).toBe("PO-2026-0042");
    expect(s.line_items).toEqual([
      { description: "Steel Widget Bracket", quantity: 50, unit_price: 12 },
      { description: "Zinc Plated Bolt M8x40", quantity: 200, unit_price: 0.75 },
    ]);
    expect(s.subtotal).toBe(750);
    expect(s.tax).toBe(60);
    expect(s.total).toBe(810);
    expect(s.currency).toBe("USD");
  });

  it("reads the multi-line block layout, with thousands separators", () => {
    const s = parseTemplateInvoice(BLOCK_INVOICE);
    expect(s.vendor_name).toBe("Acme Cloud Services");
    expect(s.invoice_number).toBe("INV-ACS-1001");
    expect(s.line_items).toEqual([{ description: "Cloud GPU Compute Cluster (A100)", quantity: 4, unit_price: 2500 }]);
    expect(s.total).toBe(10000);
  });

  it("does not let 'Subtotal:' stand in for the total (the old parser did)", () => {
    const s = parseTemplateInvoice("Acme\nInvoice #: A-1\nDate: 2026-01-02\nSubtotal: $100.00");
    expect(s.subtotal).toBe(100);
    expect(s.total).toBeNull();
  });

  it("leaves unreadable fields null instead of guessing", () => {
    const s = parseTemplateInvoice("some scanned garbage with no structure");
    expect(s.invoice_number).toBeNull();
    expect(s.invoice_date).toBeNull();
    expect(s.line_items).toEqual([]);
    expect(s.total).toBeNull();
  });
});

describe("assessExtraction", () => {
  it("is complete when fields are present and the arithmetic reconciles", () => {
    const a = assessExtraction(parseTemplateInvoice(INLINE_INVOICE));
    expect(a).toEqual({ complete: true, checkScore: 1, problems: [] });
  });

  it("flags a total that does not equal subtotal + tax", () => {
    const s = parseTemplateInvoice(INLINE_INVOICE);
    s.total = 900;
    const a = assessExtraction(s);
    expect(a.complete).toBe(false);
    expect(a.problems.join(" ")).toContain("subtotal + tax is 810.00 but total says 900.00");
    expect(a.checkScore).toBeLessThan(1);
  });

  it("flags line items that do not sum to the subtotal", () => {
    const s = parseTemplateInvoice(INLINE_INVOICE);
    s.subtotal = 700;
    expect(assessExtraction(s).problems.join(" ")).toContain("line items sum to 750.00 but subtotal says 700.00");
  });

  it("reports every missing required field", () => {
    const a = assessExtraction(parseTemplateInvoice("garbage"));
    expect(a.complete).toBe(false);
    expect(a.problems.length).toBeGreaterThanOrEqual(4);
  });
});

describe("normalizeDate", () => {
  it("accepts ISO and named-month dates", () => {
    expect(normalizeDate("2026-09-10")).toBe("2026-09-10");
    expect(normalizeDate("Sep 10, 2026")).toBe("2026-09-10");
    expect(normalizeDate("10 September 2026")).toBe("2026-09-10");
  });
  it("refuses ambiguous slash dates and impossible days", () => {
    expect(normalizeDate("03/04/2026")).toBeNull();
    expect(normalizeDate("Feb 31, 2026")).toBeNull();
  });
});

describe("extract() — what confidence means", () => {
  it("a document the template fully reads and reconciles skips the LLM and is NOT reported as 100% certain", async () => {
    const r = await extract(INLINE_INVOICE);
    expect(r.method).toBe("template");
    expect(r.model).toBe("template-parser");
    expect(r.toolCalls).toHaveLength(0);
    expect(r.submission.confidence).toBe(0.95);
    expect(r.submission.confidence).toBeLessThan(1);
  });

  it("an unreadable document with no LLM configured returns low confidence and says why — it does not pretend", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    const r = await extract("scanned image text we cannot read");
    expect(r.method).toBe("template-incomplete");
    expect(r.fallbackReason).toContain("GROQ_API_KEY");
    expect(r.submission.confidence).toBeLessThan(0.85); // below the EXC-LAYOUT threshold, so a human sees it
    expect(r.submission.uncertain_fields.length).toBeGreaterThan(0);
  });

  it("a partial parse is scored by how many checks passed", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    const text = INLINE_INVOICE.replace(/^Date:.*$/m, ""); // drop the date
    const r = await extract(text);
    expect(r.method).toBe("template-incomplete");
    expect(r.submission.invoice_date).toBeNull();
    expect(r.submission.uncertain_fields.join(" ")).toContain("invoice_date");
    expect(r.submission.confidence).toBeGreaterThan(0.5);
    expect(r.submission.confidence).toBeLessThan(0.95);
  });
});

/**
 * Live model call: only for a document the template parser cannot read, so the LLM path is the
 * one exercised. Skipped (visibly, in the report) when no provider key is configured.
 */
describe.skipIf(!liveLlm)("extract() — real LLM path", () => {
  it("reads a free-form invoice the template cannot, and its confidence comes from the arithmetic checks", async () => {
    const freeform = `
Thank you for your business!
From: Northwind Traders Ltd.
Ref no 5521-B issued 12 August 2026 against your order PO-2026-0077.
You bought 3 x Standing Desk at 400.00 each and 10 x Cable Tray at 25.00 each.
Net 1450.00, VAT 145.00, amount payable 1595.00 (GBP).
`.trim();
    const r = await extract(freeform);
    expect(r.method).toBe("llm");
    expect(r.toolCalls[0].name).toBe("submit_extraction");
    expect(r.submission.line_items.length).toBe(2);
    expect(r.submission.total).toBeCloseTo(1595, 1);
    expect(r.submission.currency).toBe("GBP");
    expect(r.submission.confidence).toBeLessThanOrEqual(0.9);
  }, 60_000);
});
