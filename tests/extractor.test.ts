import { describe, it, expect } from "vitest";
import { extract } from "@/lib/agent/extractor";

/**
 * Real call against the live OpenAI API (gpt-5-nano) — this is the only way to actually
 * verify the Responses API wiring (tool schema, function_call_output threading, forced
 * single-tool submission) is correct, not just type-compatible. One case is enough: this
 * is proving the plumbing works, not grading the model's extraction quality.
 */
describe("extract() — real OpenAI Responses API call", () => {
  it("extracts structured fields from a plain-text invoice", async () => {
    const invoiceText = `
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

    const result = await extract(invoiceText);

    expect(result.turns).toBe(1);
    expect(result.submission.invoice_number).toBe("INV-77021");
    expect(result.submission.currency).toBe("USD");
    expect(result.submission.total).toBeCloseTo(810.0, 1);
    expect(result.submission.line_items).toHaveLength(2);
    expect(result.submission.confidence).toBeGreaterThan(0.5);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("submit_extraction");
  }, 30_000);
});
