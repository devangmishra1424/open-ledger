import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { extractInvoice } from "@/lib/documents/invoice";
import { readPurchaseOrder } from "@/lib/documents/purchase-order";
import type { Reading } from "@/lib/documents/reader-client";

/**
 * Three documents from the live test pack that the reader got wrong, replayed from what the real reader (Docling)
 * produced for them (tests/fixtures/reader-edge-cases). No AI: each must be read right by the layout rules alone.
 */

const reading = (name: string): Reading =>
  JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", "reader-edge-cases", name), "utf8"));

describe("a US purchase order", () => {
  const po = readPurchaseOrder(reading("us-po-heading-and-numeric-date.json"));

  it("takes the PO number from its 'PO Number' label, not from under the 'PURCHASE ORDER' heading", () => {
    // It used to read "1200": the start of the buyer's street address under the heading.
    expect(po.poNumber).toBe("PO-NL-88213");
    expect(po.lines.map((l) => [l.description, l.quantity, l.unitPrice])).toEqual([
      ["Nitrile Exam Gloves, Medium", 20, 14.9], ["Lab Coat, Medium", 10, 32], ["Pipette Tips 200uL", 5, 48],
    ]);
  });

  it("says when an all-number date could be day/month either way, instead of silently picking one", () => {
    expect(po.missing).toEqual([expect.stringContaining('all-number date ("10/01/2026"), which could be day/month either way')]);
  });
});

describe("a GST invoice with no PO", () => {
  it("leaves the PO number empty: an empty 'Buyer's Order No.' box is not filled from the payment-terms box under it", async () => {
    const x = await extractInvoice(reading("gst-invoice-empty-po-box.json"), { llm: false });
    // It used to read "30", from "Mode/Terms of Payment: 30 Days".
    expect(x.submission.po_reference).toBeNull();
    expect(x.submission).toMatchObject({ invoice_number: "IFW/26-27/0452", total: 2950 });
  });
});

describe("a US invoice whose shipping is a row of the item table", () => {
  it("adds up: the subtotal that includes the shipping row is not called wrong, so no AI is needed", async () => {
    const x = await extractInvoice(reading("us-invoice-shipping-row-in-subtotal.json"), { llm: false });
    expect(x.method).toBe("template");
    expect(x.checks.filter((c) => !c.passed)).toEqual([]);
    expect(x.submission).toMatchObject({ invoice_number: "RLS-INV-30917", po_reference: "PO-NL-88213", total: 1024, currency: "USD" });
    // The 3-decimal unit price is kept as printed.
    expect(x.submission.line_items[0]).toMatchObject({ quantity: 2000, unit_price: 0.149 });
  });
});
