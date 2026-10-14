import type { ExtractionResult, ExtractionSubmission } from "@/lib/agent/extractor";
import { getFrontendInvoice } from "@/lib/api-shapes";
import { runInBackground } from "@/lib/background";
import { createBill } from "@/lib/bills";
import type { InvoiceExtraction } from "@/lib/documents/invoice";
import { getDocument } from "@/lib/documents/store";
import { handle, HttpError, readJsonBody, reviewerName } from "@/lib/http";
import { runPipeline } from "@/lib/pipeline/orchestrator";

export const maxDuration = 60; // the pipeline continues in the background after the response

/**
 * POST /api/invoices/from-document: saves an invoice from a document that was read by POST /api/documents/read and
 * then checked by a person on the review screen.
 *
 * Body: { documentId, reviewerName, invoice: { vendorName, invoiceNumber, invoiceDate, dueDate?, poNumber?,
 *   currency, lines: [{ description, quantity, unitPrice }], charges?: [{ label, amount }],
 *   taxLines?: [{ label, amount }], discount?, roundOff?, total } }
 *
 * The values are the person's (they may have corrected the reading), so they must add up exactly:
 * lines + charges + taxes - discount + round off = total, or 422 says by how much it is out. Charges (shipping,
 * freight) become invoice lines, so the three-way match sees them as lines nobody ordered; round off and discount
 * are the invoice's adjustment (posted to account 7300). The extract decision on the hash-chained trail records
 * how the machine read the document, who checked it, and every field they changed.
 *
 * 404 unknown document; 409 the document is already an invoice, or this vendor already sent this invoice number.
 */
export const POST = handle("POST /api/invoices/from-document", async (req) => {
  const body = await readJsonBody(req);
  const by = reviewerName(body, req);
  const documentId = typeof body.documentId === "string" ? body.documentId : "";
  if (!documentId) throw new HttpError(400, "documentId is required");
  const doc = await getDocument(documentId);
  if (!doc) throw new HttpError(404, `no document '${documentId}'`);
  if (doc.purpose !== "invoice") throw new HttpError(400, "this document was read as a purchase order, not an invoice");
  if (doc.invoiceId) throw new HttpError(409, `this document was already saved as an invoice (id ${doc.invoiceId})`);

  const inv = parseInvoice(body.invoice);
  const machine = doc.extraction as InvoiceExtraction | null;
  const read = machine?.submission;

  const tax = round2(inv.taxLines.reduce((s, t) => s + t.amount, 0));
  const adjustment = round2(inv.roundOff - inv.discount);
  const created = await createBill({
    vendorName: inv.vendorName,
    poNumber: inv.poNumber,
    invoiceNumber: inv.invoiceNumber,
    invoiceDate: inv.invoiceDate,
    dueDate: inv.dueDate,
    currency: inv.currency,
    lines: [...inv.lines, ...inv.charges.map((c) => ({ description: c.label, quantity: 1, unitPrice: c.amount }))],
    tax,
    adjustment,
    total: inv.total,
    rawSource: (doc.reading.layout_text || doc.reading.markdown).slice(0, 200_000),
    sourceDocumentId: documentId,
    strictTotals: true, // a person's figures must add up; the review screen shows the sum before saving
  });

  const saved: ExtractionSubmission = {
    vendor_name: inv.vendorName, invoice_number: inv.invoiceNumber, invoice_date: inv.invoiceDate, due_date: inv.dueDate,
    po_reference: inv.poNumber, currency: inv.currency,
    line_items: inv.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit_price: l.unitPrice })),
    subtotal: round2(inv.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0)), tax, tax_lines: inv.taxLines,
    other_charges: inv.charges, discount: inv.discount, round_off: inv.roundOff, total: inv.total,
    confidence: 1, uncertain_fields: read?.uncertain_fields ?? [],
  };
  const result: ExtractionResult = {
    submission: saved,
    method: machine?.method ?? "template",
    model: machine?.model ?? "layout-rules",
    toolCalls: machine?.toolCalls ?? [],
    turns: machine?.turns ?? 1,
    review: {
      by,
      document: { id: documentId, filename: doc.filename, sourceKind: doc.sourceKind, ocrConfidence: doc.ocrConfidence },
      machineConfidence: read?.confidence ?? 0,
      corrections: read ? corrections(read, inv) : [],
    },
  };
  runInBackground(`runPipeline(${created.billId})`, () => runPipeline(created.billId, { extraction: result }));
  console.info(`POST /api/invoices/from-document: document ${documentId} -> invoice ${created.billId} by ${by} (${result.review!.corrections.length} correction(s))`);

  const invoice = await getFrontendInvoice(created.billId);
  return Response.json({ ...invoice, corrections: result.review!.corrections, vendorCreated: created.vendorCreated }, { status: 201 });
});

const round2 = (n: number) => Math.round(n * 100) / 100;

interface ReviewedInvoice {
  vendorName: string; invoiceNumber: string; invoiceDate: string; dueDate: string | null; poNumber: string | null; currency: string;
  lines: Array<{ description: string; quantity: number; unitPrice: number }>;
  charges: Array<{ label: string; amount: number }>;
  taxLines: Array<{ label: string; amount: number }>;
  discount: number; roundOff: number; total: number;
}

function parseInvoice(raw: unknown): ReviewedInvoice {
  if (!raw || typeof raw !== "object") throw new HttpError(400, "invoice is required");
  const o = raw as Record<string, unknown>;
  const str = (k: string, required: boolean, max = 200): string | null => {
    const v = o[k];
    if (v == null || (typeof v === "string" && v.trim() === "")) {
      if (required) throw new HttpError(400, `invoice.${k} is required`);
      return null;
    }
    if (typeof v !== "string") throw new HttpError(400, `invoice.${k} must be text`);
    if (v.trim().length > max) throw new HttpError(400, `invoice.${k} is too long`);
    return v.trim();
  };
  const num = (v: unknown, label: string, min?: number): number => {
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n)) throw new HttpError(400, `${label} must be a number`);
    if (min !== undefined && n < min) throw new HttpError(400, `${label} must be at least ${min}`);
    return n;
  };
  const list = (k: string) => {
    const v = o[k] ?? [];
    if (!Array.isArray(v)) throw new HttpError(400, `invoice.${k} must be a list`);
    if (v.length > 500) throw new HttpError(400, `invoice.${k} has too many entries`);
    return v as Array<Record<string, unknown>>;
  };
  const date = (k: string, required: boolean) => {
    const v = str(k, required, 10);
    if (v != null && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, `invoice.${k} must be YYYY-MM-DD`);
    return v;
  };
  const currency = (str("currency", true, 3) ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, "invoice.currency must be a 3-letter code such as INR");
  const lines = list("lines").map((l, i) => ({
    description: typeof l.description === "string" && l.description.trim() ? l.description.trim().slice(0, 500) : (() => { throw new HttpError(400, `line ${i + 1}: description is required`); })(),
    quantity: num(l.quantity, `line ${i + 1}: quantity`, 0.0001),
    unitPrice: num(l.unitPrice, `line ${i + 1}: unit price`, 0),
  }));
  if (lines.length === 0) throw new HttpError(400, "an invoice needs at least one line");
  const labelled = (k: string, min?: number) => list(k).map((c, i) => ({
    label: typeof c.label === "string" && c.label.trim() ? c.label.trim().slice(0, 120) : (() => { throw new HttpError(400, `invoice.${k}[${i}]: label is required`); })(),
    amount: num(c.amount, `invoice.${k}[${i}]: amount`, min),
  }));
  return {
    vendorName: str("vendorName", true)!,
    invoiceNumber: str("invoiceNumber", true, 60)!,
    invoiceDate: date("invoiceDate", true)!,
    dueDate: date("dueDate", false),
    poNumber: str("poNumber", false, 60),
    currency,
    lines,
    charges: labelled("charges", 0),
    taxLines: labelled("taxLines", 0),
    discount: o.discount == null || o.discount === "" ? 0 : num(o.discount, "invoice.discount", 0),
    roundOff: o.roundOff == null || o.roundOff === "" ? 0 : num(o.roundOff, "invoice.roundOff"),
    total: num(o.total, "invoice.total", 0.01),
  };
}

/** What the person changed from the machine's reading, field by field, in words for the trail. */
function corrections(read: ExtractionSubmission, saved: ReviewedInvoice): Array<{ field: string; read: string; saved: string }> {
  const out: Array<{ field: string; read: string; saved: string }> = [];
  const cmp = (field: string, a: unknown, b: unknown) => {
    const sa = a == null || a === "" ? "(not read)" : String(a);
    const sb = b == null || b === "" ? "(blank)" : String(b);
    if (sa.trim().toLowerCase() !== sb.trim().toLowerCase()) out.push({ field, read: sa, saved: sb });
  };
  cmp("vendor", read.vendor_name, saved.vendorName);
  cmp("invoice number", read.invoice_number, saved.invoiceNumber);
  cmp("invoice date", read.invoice_date, saved.invoiceDate);
  cmp("PO number", read.po_reference, saved.poNumber);
  cmp("currency", read.currency, saved.currency);
  const money = (v: number | null | undefined) => (v == null ? null : v.toFixed(2));
  cmp("total", money(read.total), money(saved.total));
  cmp("tax", money(read.tax), money(round2(saved.taxLines.reduce((s, t) => s + t.amount, 0))));
  const readLines = read.line_items.map((l) => `${l.quantity} x ${l.unit_price} ${l.description}`.toLowerCase()).join(" | ");
  const savedLines = saved.lines.map((l) => `${l.quantity} x ${l.unitPrice} ${l.description}`.toLowerCase()).join(" | ");
  if (readLines !== savedLines) out.push({ field: "line items", read: `${read.line_items.length} line(s)`, saved: `${saved.lines.length} line(s), edited` });
  return out;
}
