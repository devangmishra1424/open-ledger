import { describe, it, expect, vi, afterEach } from "vitest";
import { extract, parseTemplateInvoice, assessExtraction } from "@/lib/agent/extractor";
import { extractPdfText } from "@/lib/pdf-text";
import { makePdfDataUrl, drawTableInvoice } from "./helpers/make-pdf";

afterEach(() => vi.unstubAllEnvs());

const TABLE_INVOICE = `Northwind Parts Ltd.
12 Market Road, Pune
INVOICE
Invoice No: NW-4471
Date: 2026-10-09
PO Number: PO-2026-7001
Description Qty Unit Price Amount
Industrial Bearing Set 12 $145.00 $1,740.00
Maintenance Kit 4 $62.50 $250.00
Zinc Plated Bolt M8x40 200 $0.75 $150.00
Subtotal $2,140.00
Tax (8%) $171.20
Total $2,311.20`;

describe("table-style invoices (the layout most exported invoices have)", () => {
  it("reads the rows and the colon-less totals, and the arithmetic reconciles", () => {
    const s = parseTemplateInvoice(TABLE_INVOICE);
    expect(s).toMatchObject({ vendor_name: "Northwind Parts Ltd.", invoice_number: "NW-4471", invoice_date: "2026-10-09", po_reference: "PO-2026-7001", subtotal: 2140, tax: 171.2, total: 2311.2 });
    expect(s.line_items).toEqual([
      { description: "Industrial Bearing Set", quantity: 12, unit_price: 145 },
      { description: "Maintenance Kit", quantity: 4, unit_price: 62.5 },
      { description: "Zinc Plated Bolt M8x40", quantity: 200, unit_price: 0.75 },
    ]);
    expect(assessExtraction(s)).toMatchObject({ complete: true, problems: [] });
  });

  it("several tax lines (CGST + SGST) add up to the tax, and the document still reconciles", () => {
    const s = parseTemplateInvoice(TABLE_INVOICE.replace("Tax (8%) $171.20", "CGST 4% $85.60\nSGST 4% $85.60"));
    expect(s.tax).toBe(171.2);
    expect(assessExtraction(s).complete).toBe(true);
  });

  it("a tax label it does not recognise leaves the total unreconciled, so a person sees the document", () => {
    const s = parseTemplateInvoice(TABLE_INVOICE.replace("Tax (8%) $171.20", "Levy 8% $171.20"));
    expect(assessExtraction(s).complete).toBe(false);
  });

  it("a row it cannot read is left out, so the lines no longer add up to the subtotal and the read is NOT trusted", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    const broken = TABLE_INVOICE.replace("Maintenance Kit 4 $62.50 $250.00", "Maintenance Kit 4 $62.50 $999.00"); // amount is not 4 x 62.50
    const r = await extract(broken);
    expect(r.method).toBe("template-incomplete");
    expect(r.submission.confidence).toBeLessThan(0.85);
    expect(r.submission.uncertain_fields.join(" ")).toMatch(/line items sum to/);
  });

  it("a real PDF of such an invoice is read end to end by the deterministic path, no AI call", async () => {
    vi.stubEnv("GROQ_API_KEY", ""); // proves no model was needed
    const text = await extractPdfText(await makePdfDataUrl((doc) => drawTableInvoice(doc)));
    const r = await extract(text);
    expect(r.method).toBe("template");
    expect(r.submission.confidence).toBeGreaterThanOrEqual(0.85);
    expect(r.submission).toMatchObject({ invoice_number: "NW-4471", po_reference: "PO-2026-7001", total: 2311.2 });
    expect(r.submission.line_items).toHaveLength(3);
  });

  it("an invoice with a 'Total Qty' line does not take the quantity for the total", () => {
    const s = parseTemplateInvoice(TABLE_INVOICE.replace("Subtotal $2,140.00", "Total Qty 216\nSubtotal $2,140.00"));
    expect(s.total).toBe(2311.2);
  });
});
