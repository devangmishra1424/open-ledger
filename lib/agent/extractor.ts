import { EXTRACTOR_PROMPT } from "@/lib/agent/prompts";
import { SUBMIT_EXTRACTION } from "@/lib/agent/tools";
import { runResponsesLoop, type AgentLoopResult } from "@/lib/agent/loop-responses";

/** Matches submit_extraction's parameter schema in lib/agent/tools.ts exactly. */
export interface ExtractionSubmission {
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  po_reference: string | null;
  line_items: Array<{ description: string; quantity: number; unit_price: number }>;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  currency: string | null;
  confidence: number;
  uncertain_fields: string[];
}

export async function extract(invoiceText: string): Promise<AgentLoopResult<ExtractionSubmission>> {
  // Deterministic Regex Parser
  // We extract basic fields based on standard templates.
  const submission: ExtractionSubmission = {
    vendor_name: null,
    invoice_number: null,
    invoice_date: null,
    po_reference: null,
    line_items: [],
    subtotal: null,
    tax: null,
    total: null,
    currency: "USD",
    confidence: 1.0,
    uncertain_fields: []
  };

  const lines = invoiceText.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  
  // Very naive extraction for demo
  for (const line of lines) {
    if (line.match(/Invoice Number:/i)) {
      submission.invoice_number = line.split(/:/)[1].trim();
    }
    if (line.match(/Invoice Date:/i)) {
      submission.invoice_date = line.split(/:/)[1].trim();
    }
    if (line.match(/Purchase Order:/i) || line.match(/PO Number:/i)) {
      submission.po_reference = line.split(/:/)[1].trim();
    }
    if (line.match(/Subtotal:/i)) {
      const match = line.match(/([\d,]+(\.\d+)?)/);
      if (match) submission.subtotal = parseFloat(match[1].replace(/,/g, ''));
    }
    if (line.match(/Tax.*:/i)) {
      const match = line.match(/([\d,]+(\.\d+)?)/);
      if (match) submission.tax = parseFloat(match[1].replace(/,/g, ''));
    }
    if (line.match(/Total Amount Due:/i) || line.match(/Total:/i)) {
      const match = line.match(/([\d,]+(\.\d+)?)/);
      if (match) submission.total = parseFloat(match[1].replace(/,/g, ''));
    }
  }
  
  // Vendor Name - first line is often the vendor
  if (lines.length > 0 && !lines[0].match(/INVOICE/i)) {
    submission.vendor_name = lines[0];
  } else if (lines.length > 1) {
    submission.vendor_name = lines[1];
  }

  // Extract lines between "Line Items:" and "---" or "Subtotal"
  let inLineItems = false;
  let currentItem: Partial<{description: string; quantity: number; unit_price: number}> = {};

  for (const line of lines) {
    if (line.match(/Line Items:/i)) {
      inLineItems = true;
      continue;
    }
    if (inLineItems && (line.match(/---|Subtotal/i) || line.match(/Please make all checks/i))) {
      inLineItems = false;
      continue;
    }
    if (inLineItems) {
      if (line.match(/^\d+\./)) {
        if (currentItem.description && currentItem.unit_price) {
           submission.line_items.push(currentItem as any);
        }
        currentItem = { description: line.replace(/^\d+\.\s*/, '').trim() };
      } else if (line.match(/Qty:/i)) {
        const match = line.match(/Qty:\s*(\d+)/i);
        if (match) currentItem.quantity = parseInt(match[1]);
      } else if (line.match(/Unit Price:/i)) {
        const match = line.match(/Unit Price:\s*\$?([\d,]+(\.\d+)?)/i);
        if (match) currentItem.unit_price = parseFloat(match[1].replace(/,/g, ''));
      }
    }
  }
  if (currentItem.description && currentItem.unit_price && currentItem.quantity) {
     submission.line_items.push(currentItem as any);
  }

  return {
    submission,
    toolCalls: [],
    turns: 1
  };
}
