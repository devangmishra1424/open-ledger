import { normalizeDate, parseTemplateInvoice } from "@/lib/agent/extractor";

/**
 * Reading a PURCHASE ORDER document (pasted text or the text of an uploaded PDF) into a DRAFT.
 *
 * A PO is a record the AP system relies on, so nothing here writes it: the draft goes back to the
 * person, who checks and edits every field before saving (POST /api/purchase-orders). It reuses the
 * invoice template parser (vendor, date, line items in the block, inline or table layouts) because a
 * PO is laid out the same way, and adds the PO-number and order-date labels. There is no AI fallback
 * here: a layout it cannot read comes back with what is missing, and the person types the rest.
 */

export interface PoDraft {
  vendorName: string | null;
  poNumber: string | null;
  orderDate: string | null;
  currency: string | null;
  lines: Array<{ description: string; quantity: number; unitPrice: number }>;
  /** What could not be read, in plain words. Empty when every field was found (still worth checking). */
  missing: string[];
}

const PO_NUMBER = /^(?:purchase\s*order|po)(?:\s*(?:number|no\.?|#))?\s*[:#]\s*(.+)$/im;
const ORDER_DATE = /^(?:order|po|purchase\s*order)\s*date\s*:\s*(.+)$/im;

export function parsePurchaseOrderText(text: string): PoDraft {
  const s = parseTemplateInvoice(text);
  const poNumber = s.po_reference ?? text.match(PO_NUMBER)?.[1].trim() ?? null;
  const dated = text.match(ORDER_DATE)?.[1];
  const orderDate = (dated ? normalizeDate(dated) : null) ?? s.invoice_date;

  const missing: string[] = [];
  if (!s.vendor_name) missing.push("the vendor");
  if (!poNumber) missing.push("the PO number");
  if (!orderDate) missing.push("the order date");
  if (s.line_items.length === 0) missing.push("the line items");

  return { vendorName: s.vendor_name, poNumber, orderDate, currency: s.currency, lines: s.line_items.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unit_price })), missing };
}
