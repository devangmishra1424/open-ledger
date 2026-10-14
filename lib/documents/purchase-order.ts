import { dateOrderFor, detectCurrency, parseDate } from "@/lib/documents/formats";
import { documentText, rowsFromReading } from "@/lib/documents/layout";
import { LABELS, labelledValue, readLines } from "@/lib/documents/invoice-rules";
import type { Reading } from "@/lib/documents/reader-client";

/**
 * A purchase-order document read into a DRAFT for the person to check, edit and save (the PO form). Same layout
 * rules as invoices, with one difference that matters: on a PO the letterhead is the BUYER (your own company), so
 * the vendor is the party named in the "Vendor" / "Supplier" / "To" block, never the letterhead. No AI is used:
 * what cannot be read is listed in `missing` and typed in by the person.
 */

export interface PoDraft {
  vendorName: string | null;
  poNumber: string | null;
  orderDate: string | null;
  currency: string | null;
  lines: Array<{ description: string; quantity: number; unitPrice: number; uom: string | null }>;
  /** What could not be read or does not add up, in plain words. Empty when every field was found (still worth checking). */
  missing: string[];
}

const PO_NUMBER = /^(?:p\.?\s*o\.?|purchase\s*order|order)\s*(?:no\.?|number|#|ref(?:erence)?)?(?!\s*date)(?=[\s:#.]|$)/i;
const ORDER_DATE = /^(?:(?:po|p\.o\.|order|purchase\s*order)\s*date|date\s*of\s*order|date)(?=[\s:.\-]|$)/i;
const VENDOR = /^(?:vendor(?:\s*(?:name|details))?|supplier(?:\s*(?:name|details))?|to|seller|ship\s*from|issued\s*to)(?=[\s:.,\-]|$)/i;

export function readPurchaseOrder(reading: Reading): PoDraft {
  const rows = rowsFromReading(reading);
  const text = documentText(rows);
  const currency = detectCurrency(text);
  const order = dateOrderFor(currency, text);

  const vendor = labelledValue(rows, VENDOR, "text") ?? labelledValue(rows, LABELS.vendor, "text");
  const poNumber = labelledValue(rows, PO_NUMBER, "id");
  const dated = labelledValue(rows, ORDER_DATE, "date", order);
  const orderDate = dated ? parseDate(dated.value, order)?.iso ?? null : null;
  const { lines, problems } = readLines(rows);

  const missing: string[] = [];
  if (!vendor) missing.push("the vendor (no Vendor / Supplier / To block was found)");
  if (!poNumber) missing.push("the PO number");
  if (!orderDate) missing.push("the order date");
  if (lines.length === 0) missing.push("the line items");
  for (const p of problems) if (!p.endsWith("no item table found")) missing.push(p.replace(/^line_items: /, ""));
  if (vendor?.conf != null || poNumber?.conf != null) missing.push("this was read by OCR: check the vendor name and PO number letter by letter");

  return {
    vendorName: vendor?.value ?? null,
    poNumber: poNumber?.value ?? null,
    orderDate,
    currency,
    lines: lines.filter((l) => !l.problem).map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unit_price, uom: l.uom })),
    missing,
  };
}
