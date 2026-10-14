import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rowsFromReading, groupIntoLines, type DocCell } from "@/lib/documents/layout";
import { readInvoiceRules } from "@/lib/documents/invoice-rules";
import { assessInvoice, extractInvoice, REVIEW_THRESHOLD } from "@/lib/documents/invoice";
import { readPurchaseOrder } from "@/lib/documents/purchase-order";
import type { Reading } from "@/lib/documents/reader-client";
import type { ExtractionSubmission } from "@/lib/agent/extractor";

/**
 * Invoice and PO field reading on REAL reader output: the saved readings in eval/documents/readings/ are what the
 * document reader (Docling + OCR) returned for the generated test set, so these tests exercise the field rules on
 * genuine OCR text, positions and slips, without needing the reader or a database. Each test names the bug it
 * guards against. The whole set is scored by eval/documents/run.ts (CI fails on any silent error).
 */

const ROOT = join(process.cwd(), "eval", "documents");
function reading(folder: "invoices" | "purchase_orders", layout: string, form: string): Reading {
  const bytes = readFileSync(join(ROOT, folder, layout, form));
  const hash = createHash("sha256").update(bytes).digest("hex");
  return JSON.parse(readFileSync(join(ROOT, "readings", `${hash}.json`), "utf8"));
}
const rules = (layout: string, form: string) => readInvoiceRules(rowsFromReading(reading("invoices", layout, form)));

describe("invoice field rules on real readings", () => {
  it("a Tally-style boxed GST invoice: items read from the page's rows even where the table model merged the grid", () => {
    const r = rules("tally_gst", "digital.pdf");
    expect(r.line_items.map((l) => [l.quantity, l.unit_price])).toEqual([[500, 6.4], [500, 0.85], [12, 285], [24, 145.5]]);
    expect(r.tax).toBe(1896.66);
    expect(r.round_off).toBe(0.34);
    expect(r.total).toBe(12434);
    expect(r.invoice_number).toBe("SGIS/2026-27/0412");
    expect(r.invoice_date).toBe("2026-09-12");
  });

  it("the same invoice from a phone photo (perspective, uneven light, OCR) reads the same", () => {
    const r = rules("tally_gst", "photo.jpg");
    expect(r.line_items).toHaveLength(4);
    expect(r.total).toBe(12434);
    expect(r.po_reference).toBe("PO-2026-0871");
  });

  it("regression: a value like PO-7731 is not mistaken for a 'PO' label (the prefix used to be cut to 7731)", () => {
    expect(rules("us_invoice", "digital.pdf").po_reference).toBe("PO-7731");
    expect(rules("uk_vat", "digital.pdf").po_reference).toBe("PO-UK-2219");
  });

  it("regression: tax registration lines are not taxes (a VAT number and a company number once read as tax of 8,812,274)", () => {
    const uk = rules("uk_vat", "digital.pdf");
    expect(uk.tax).toBe(49.59);
    expect(uk.tax_lines).toEqual([{ label: "VAT @ 20%", amount: 49.59 }]);
    const zoho = rules("zoho_igst", "digital.pdf");
    expect(zoho.tax).toBe(10980); // a "GSTIN ..." row beside the balance due is not a tax line
  });

  it("regression: 'Net Payable' is the total, not a 'Net ...' subtotal", () => {
    const r = rules("discount_uom", "digital.pdf");
    expect(r.total).toBe(32368);
    expect(r.round_off).toBe(-0.35);
  });

  it("line discounts: the unit price is what is charged per unit after the discount", () => {
    const r = rules("discount_uom", "digital.pdf");
    expect(r.line_items.map((l) => [l.quantity, l.unit_price])).toEqual([[25, 608], [4.5, 2450], [40, 115.05]]);
  });

  it("numbers drift right of their header: the price column is read by order, not position (32.50 once landed in Amount)", () => {
    const r = rules("us_invoice", "digital.pdf");
    expect(r.line_items.map((l) => l.unit_price)).toEqual([189, 32.5, 74.95]);
    expect(r.other_charges).toEqual([{ label: "Shipping & Handling", amount: 45 }]);
  });

  it("an OCR slip in a totals label ('Totat') still reads as the total", () => {
    expect(rules("tally_gst", "scan_messy.pdf").total).toBe(12434);
  });

  it("dates by the document's country: 05/10/2026 is 5 Oct on an Indian invoice, 10/02/2026 is 2 Oct on a US one", () => {
    expect(rules("zoho_igst", "digital.pdf").invoice_date).toBe("2026-10-05");
    expect(rules("us_invoice", "digital.pdf").invoice_date).toBe("2026-10-02");
  });

  it("a bill with no table ('1000 nos @ 1.20 = 1,200.00') and an OCR'd date with a dropped space ('October2026')", () => {
    const r = rules("plain_bill", "photo.jpg");
    expect(r.line_items).toHaveLength(3);
    expect(r.invoice_date).toBe("2026-10-03");
    expect(r.total).toBe(3500);
  });

  it("a 28-line invoice over two pages keeps every line, past the repeated header", () => {
    const r = rules("multipage_gst", "digital.pdf");
    expect(r.line_items).toHaveLength(28);
    expect(r.total).toBe(198249);
  });
});

describe("how far a reading is trusted", () => {
  it("an OCR'd vendor name printed only once is flagged for its spelling (OCR read 'Rohan PrintStudio')", async () => {
    const x = await extractInvoice(reading("invoices", "plain_bill", "photo.jpg"), { llm: false });
    expect(x.submission.vendor_name).toBe("Rohan PrintStudio");
    expect(x.submission.uncertain_fields.some((u) => u.startsWith("vendor_name"))).toBe(true);
    expect(x.submission.confidence).toBeLessThan(REVIEW_THRESHOLD);
  });

  it("a clean digital invoice that adds up is trusted without AI", async () => {
    const x = await extractInvoice(reading("invoices", "tally_gst", "digital.pdf"), { llm: false });
    expect(x.method).toBe("template");
    expect(x.submission.confidence).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
    expect(x.checks.every((c) => c.passed)).toBe(true);
  });

  it("regression: a line pairing a list price with a discounted amount fails (quantity x price must be the amount)", () => {
    const s: ExtractionSubmission = {
      vendor_name: "V", invoice_number: "1", invoice_date: "2026-10-01", po_reference: null, currency: "INR",
      line_items: [{ description: "Pepper", quantity: 25, unit_price: 640, amount: 15200 }],
      subtotal: 15200, tax: 0, total: 15200, confidence: 0, uncertain_fields: [],
    };
    const a = assessInvoice(s);
    expect(a.checks.find((c) => c.check.startsWith("each line"))?.passed).toBe(false);
    expect(a.problems.join(" ")).toMatch(/25 x 640 is not its amount 15200/);
  });
});

describe("the AI reader fills gaps but cannot invent", () => {
  beforeEach(() => vi.stubEnv("GROQ_API_KEY", "test-key"));
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules(); });

  async function withAi(answer: Record<string, unknown>) {
    vi.resetModules();
    vi.doMock("@/lib/agent/loop", () => ({
      runToolLoop: vi.fn(async () => ({ submission: answer, toolCalls: [], turns: 1, model: "test-model" })),
    }));
    const mod = await import("@/lib/documents/invoice");
    return mod.extractInvoice;
  }

  it("a value the AI returns that is not printed in the document is refused, and said so", async () => {
    const r = reading("invoices", "zoho_igst", "photo.jpg");
    // break the rules' invoice number so the AI is asked, and have it answer with a number that is not on the page
    const doctored = { ...r, layout: r.layout.map((p) => ({ ...p, rows: p.rows.map((row) => row.filter((c) => !c.text.includes("KCS-INV"))) })) };
    const extract = await withAi({ invoice_number: "KCS-INV-99999", vendor_name: null, vendor_tax_id: null, invoice_date: null, due_date: null, po_reference: null, currency: null, line_items: [], subtotal: null, tax_lines: [], other_charges: [], discount: null, round_off: null, total: null, uncertain_fields: [] });
    const x = await extract(doctored as Reading, { llm: true });
    expect(x.submission.invoice_number).toBeNull();
    expect(x.submission.uncertain_fields.join(" ")).toMatch(/AI suggested "KCS-INV-99999", which is not printed/);
  });

  it("a gap the AI fills with a value that IS printed is used, and marked as read by the AI", async () => {
    const r = reading("invoices", "plain_bill", "digital.pdf");
    const doctored = { ...r, layout: r.layout.map((p) => ({ ...p, rows: p.rows.map((row) => row.filter((c) => !/^Invoice No/.test(c.text))) })) };
    const extract = await withAi({ invoice_number: "RPS-0093", vendor_name: null, vendor_tax_id: null, invoice_date: null, due_date: null, po_reference: null, currency: null, line_items: [], subtotal: null, tax_lines: [], other_charges: [], discount: null, round_off: null, total: null, uncertain_fields: [] });
    // the number is still printed elsewhere? It is not: take it from the original text instead, which still has it
    const x = await extract({ ...doctored, layout_text: r.layout_text } as Reading, { llm: true });
    expect(x.method).toBe("llm");
    expect(x.fieldSources.invoice_number ?? null).not.toBe("rules");
  });
});

describe("purchase orders", () => {
  it.each([["po_indian", "digital.pdf"], ["po_indian", "scan_clean.pdf"], ["po_indian", "photo.jpg"], ["po_us", "digital.pdf"], ["po_us", "scan_messy.pdf"]])(
    "%s/%s: every field matches the answer key", (layout, form) => {
      const truth = JSON.parse(readFileSync(join(ROOT, "purchase_orders", layout, "truth.json"), "utf8"));
      const d = readPurchaseOrder(reading("purchase_orders", layout, form));
      expect({ vendorName: d.vendorName, poNumber: d.poNumber, orderDate: d.orderDate, currency: d.currency })
        .toEqual({ vendorName: truth.vendor_name, poNumber: truth.po_number, orderDate: truth.order_date, currency: truth.currency });
      expect(d.lines.map((l) => [l.quantity, l.unitPrice])).toEqual(truth.line_items.map((l: any) => [l.quantity, l.unit_price]));
    },
  );

  it("the vendor comes from the Vendor / Supplier block, never the buyer's own letterhead", () => {
    const indian = readPurchaseOrder(reading("purchase_orders", "po_indian", "digital.pdf"));
    expect(indian).toMatchObject({ vendorName: "Shree Ganesh Industrial Supplies", poNumber: "PO-2026-0871", orderDate: "2026-09-02", currency: "INR" });
    expect(indian.lines).toHaveLength(4);
    const us = readPurchaseOrder(reading("purchase_orders", "po_us", "scan_messy.pdf"));
    expect(us).toMatchObject({ vendorName: "Bayside Industrial Supply Co.", poNumber: "PO-7731", orderDate: "2026-09-18", currency: "USD" });
  });
});

describe("printed lines from positioned text", () => {
  const cell = (text: string, x0: number, x1: number, y0: number, y1: number): DocCell => ({ text, x0, x1, y0, y1, conf: null });

  it("regression: two labels printed one under the other are not merged into one line (P.O. NUMBER / DUE DATE on a photo)", () => {
    const lines = groupIntoLines([cell("P.O. NUMBER", 636, 740, 300, 314), cell("DUE DATE", 637, 718, 309, 323), cell("PO-7731", 862, 928, 302, 316)]);
    expect(lines.map((l) => l.map((c) => c.text))).toEqual([["P.O. NUMBER", "PO-7731"], ["DUE DATE"]]);
  });

  it("an OCR box drawn slightly wide (the serial number nicking the description) does not split a line", () => {
    const lines = groupIntoLines([cell("1", 75, 101, 400, 414), cell("Annual Software Licence", 94, 437, 401, 415), cell("37,000.00", 864, 930, 400, 414)]);
    expect(lines).toHaveLength(1);
  });
});
