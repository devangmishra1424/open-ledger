import { getSql } from "@/db/client";
import { vendorKey } from "@/lib/bills";
import { bankAccountLast4, isCreditNote } from "@/lib/documents/hints";
import { extractInvoice, type InvoiceExtraction } from "@/lib/documents/invoice";
import { documentText, rowsFromReading } from "@/lib/documents/layout";
import { readPurchaseOrder, type PoDraft } from "@/lib/documents/purchase-order";
import { matchReceiptToPo, readGoodsReceipt, type ReceiptDraft } from "@/lib/documents/receipt";
import { MAX_UPLOAD_BYTES, readDocument, SUPPORTED_UPLOAD_EXTENSIONS, textReading, type Reading } from "@/lib/documents/reader-client";
import { findByHash, saveDocument, sha256, type DocumentPurpose } from "@/lib/documents/store";
import { handle, HttpError } from "@/lib/http";
import { getPurchaseOrder, type PoSummary } from "@/lib/purchase-orders";

export const maxDuration = 300; // a scanned multi-page document on a small CPU takes tens of seconds, then the AI reader may run

const MAX_TEXT_CHARS = 200_000;
const PURPOSES: DocumentPurpose[] = ["invoice", "purchase_order", "goods_receipt"];

/**
 * POST /api/documents/read: reads one business document and returns what it says, for a person to check before
 * anything is saved. Nothing is booked here; the invoice is created by POST /api/invoices/from-document (the PO by
 * POST /api/purchase-orders, the goods receipt by POST /api/purchase-orders/:id/receipts) after the person has
 * reviewed the fields.
 *
 * Body: multipart/form-data with `file` (PDF with or without a text layer, a photo or other image, Word, Excel,
 * PowerPoint, HTML, CSV, text) and `purpose` (invoice | purchase_order | goods_receipt), plus `poId` for a goods
 * receipt being recorded against a PO; or JSON { text, purpose, poId? } for pasted text.
 *
 * The file is read by the document reader (Docling + OCR), its fields are extracted (lib/documents/invoice.ts,
 * purchase-order.ts or receipt.ts) and the original is stored (source_documents) so the review screen and later the
 * invoice page can show it. The answer also says what the books already know: whether the vendor exists, whether
 * the PO the document cites is on file (and for whom), and whether this invoice number was already received; whether it is
 * a credit note and which of the vendor's invoices it credits; the bank account it asks to be paid into (last 4
 * digits only) against the one on file; for a goods receipt, which PO line each item is and what does not fit (lib/documents/receipt.ts matchReceiptToPo).
 *
 * Errors: 400 bad input, 413 too large, 415 unsupported type, 422 nothing readable, 503 reader not running/busy.
 */
export const POST = handle("POST /api/documents/read", async (req) => {
  const { bytes, filename, mediaType, purpose, pastedText, poId } = await parseUpload(req);
  const hash = sha256(bytes);
  // the PO a goods receipt is being recorded against: looked up first, so an unknown PO is refused before any reading
  const po = purpose === "goods_receipt" && poId ? await getPurchaseOrder(poId) : null;
  if (poId && purpose === "goods_receipt" && !po) throw new HttpError(404, `no purchase order found with id '${poId}'`);

  // Exactly this file, uploaded before for the same purpose: reuse that reading (no OCR, no AI), and say so.
  const earlier = await findByHash(hash, purpose);
  let reading: Reading;
  let extraction: InvoiceExtraction | PoDraft | ReceiptDraft;
  let documentId: string;
  if (earlier) {
    reading = earlier.reading;
    // a receipt is read again from the stored reading (rules only, milliseconds): the PO's currency decides how an
    // all-number date is read, and this time it may be recorded against a different PO
    extraction = purpose === "goods_receipt" ? readGoodsReceipt(reading, { currencyHint: po?.currency }) : earlier.extraction as InvoiceExtraction | PoDraft;
    documentId = earlier.id;
  } else {
    reading = pastedText != null ? textReading(pastedText, filename) : await readDocument({ bytes, filename, mediaType });
    if (reading.markdown.length > MAX_TEXT_CHARS) throw new HttpError(413, `the document's text is too long (max ${MAX_TEXT_CHARS} characters)`);
    extraction = purpose === "invoice" ? await extractInvoice(reading, { llm: true })
      : purpose === "purchase_order" ? readPurchaseOrder(reading)
      : readGoodsReceipt(reading, { currencyHint: po?.currency });
    documentId = await saveDocument({ bytes, filename, mediaType: pastedText != null ? "text/plain" : reading.media_type, purpose, reading, extraction, uploadedBy: null });
  }

  const books = purpose === "invoice" ? await invoiceAgainstBooks(extraction as InvoiceExtraction, documentText(rowsFromReading(reading)))
    : purpose === "purchase_order" ? await poAgainstBooks(extraction as PoDraft)
    : await receiptAgainstBooks(extraction as ReceiptDraft, po);
  console.info(`POST /api/documents/read: ${purpose} ${documentId} (${reading.source_kind}, ${reading.page_count} page(s), ocr ${reading.ocr_used ? reading.ocr_confidence : "no"})${earlier ? " [same file as before]" : ""}`);

  return Response.json({
    documentId,
    fileUrl: `/api/documents/${documentId}/file`,
    purpose,
    reading: {
      filename: reading.filename, mediaType: reading.media_type, sourceKind: reading.source_kind, pageCount: reading.page_count,
      ocrUsed: reading.ocr_used, ocrConfidence: reading.ocr_confidence, preparation: reading.preparation, warnings: reading.warnings,
      timingMs: reading.timing_ms, reader: reading.reader,
      // the text as read, row by row: shown in place of a preview for files a browser cannot display (Word, Excel)
      text: (reading.layout_text || reading.markdown).slice(0, 60_000),
    },
    extraction,
    books,
    alreadyUploaded: earlier ? { uploadedAt: earlier.uploadedAt, invoiceId: earlier.invoiceId, purchaseOrderId: earlier.purchaseOrderId, receiptId: earlier.receiptId } : null,
  }, { status: earlier ? 200 : 201 });
});

interface Upload { bytes: Uint8Array; filename: string; mediaType: string; purpose: DocumentPurpose; pastedText: string | null; poId: string | null }

function poIdOf(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 100) throw new HttpError(400, "poId must be a purchase order id");
  return value;
}

async function parseUpload(req: Request): Promise<Upload> {
  const type = req.headers.get("content-type") ?? "";
  if (type.startsWith("application/json")) {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      throw new HttpError(400, "request body is not valid JSON");
    }
    const purpose = purposeOf(body.purpose);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) throw new HttpError(400, "text is required (or upload a file as multipart/form-data)");
    if (text.length > MAX_TEXT_CHARS) throw new HttpError(413, `text is too long (max ${MAX_TEXT_CHARS} characters)`);
    return { bytes: new TextEncoder().encode(text), filename: "pasted text", mediaType: "text/plain", purpose, pastedText: text, poId: poIdOf(body.poId) };
  }
  if (!type.startsWith("multipart/form-data")) throw new HttpError(415, "send the document as multipart/form-data (field `file`) or JSON { text }");

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_UPLOAD_BYTES + 64 * 1024) throw new HttpError(413, `the file is too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, "could not read the upload (malformed multipart body)");
  }
  const purpose = purposeOf(form.get("purpose"));
  const poId = poIdOf(form.get("poId"));
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "file is required");
  if (file.size === 0) throw new HttpError(400, "the file is empty");
  if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, `the file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the most is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  const filename = (file.name || "document").replace(/[\\/]/g, "_").slice(0, 200);
  const ext = filename.includes(".") ? `.${filename.split(".").pop()!.toLowerCase()}` : "";
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (ext === ".txt") {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
    if (!text) throw new HttpError(422, "the text file is empty");
    return { bytes, filename, mediaType: "text/plain", purpose, pastedText: text, poId };
  }
  if (!SUPPORTED_UPLOAD_EXTENSIONS.includes(ext)) {
    throw new HttpError(415, `${filename}: this file type is not supported. Supported: ${[...SUPPORTED_UPLOAD_EXTENSIONS, ".txt"].join(", ")}`);
  }
  return { bytes, filename, mediaType: file.type || "application/octet-stream", purpose, pastedText: null, poId };
}

function purposeOf(value: unknown): DocumentPurpose {
  const p = typeof value === "string" ? value : "invoice";
  if (!PURPOSES.includes(p as DocumentPurpose)) throw new HttpError(400, `purpose must be one of ${PURPOSES.join(", ")}`);
  return p as DocumentPurpose;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** An existing vendor for a name read off a document: the same name (case and spaces aside), or the same letters
 *  once punctuation and spaces are ignored (OCR drops spaces: "Rohan PrintStudio"), which is offered, not assumed. */
async function matchVendor(name: string | null): Promise<{ id: string; name: string; exact: boolean } | null> {
  if (!name) return null;
  const vendors = await getSql()`SELECT id, name FROM vendors ORDER BY created_at, id`;
  const exact = vendors.find((v: any) => vendorKey(v.name) === vendorKey(name));
  if (exact) return { id: exact.id, name: exact.name, exact: true };
  const loose = vendors.find((v: any) => squash(v.name) === squash(name));
  return loose ? { id: loose.id, name: loose.name, exact: false } : null;
}

async function invoiceAgainstBooks(x: InvoiceExtraction, text: string) {
  const s = x.submission;
  const vendor = await matchVendor(s.vendor_name);
  const sql = getSql();
  let po: { number: string; onFile: boolean; vendorName: string | null; sameVendor: boolean } | null = null;
  if (s.po_reference) {
    const [row] = await getSql()`SELECT p.po_number, v.name AS vendor_name FROM purchase_orders p JOIN vendors v ON v.id = p.vendor_id WHERE p.po_number = ${s.po_reference}`;
    po = { number: s.po_reference, onFile: Boolean(row), vendorName: row?.vendor_name ?? null, sameVendor: Boolean(row && s.vendor_name && vendorKey(row.vendor_name) === vendorKey(s.vendor_name)) };
  }
  let duplicateInvoiceId: string | null = null;
  if (vendor && s.invoice_number) {
    const [dup] = await getSql()`SELECT id FROM vendor_bills WHERE vendor_id = ${vendor.id} AND invoice_number = ${s.invoice_number}`;
    duplicateInvoiceId = dup?.id ?? null;
  }

  // A credit note names the invoice it credits: the vendor's own invoice whose number is printed on it.
  const creditNote = isCreditNote(text);
  let creditedInvoice: { id: string; number: string; status: string } | null = null;
  if (creditNote && vendor) {
    const own = squash(s.invoice_number ?? "");
    const printed = squash(text);
    const candidates = await sql`
      SELECT id, invoice_number, status FROM vendor_bills WHERE vendor_id = ${vendor.id} AND invoice_type = 'standard'
      ORDER BY received_at DESC LIMIT 500`;
    const hit = candidates.find((c: any) => {
      const n = squash(c.invoice_number);
      return n.length >= 4 && n !== own && printed.includes(n);
    });
    creditedInvoice = hit ? { id: hit.id, number: hit.invoice_number, status: hit.status } : null;
  }

  // Only the last 4 digits of an account are ever read out or kept.
  const onInvoice = bankAccountLast4(text);
  let onFile: string | null = null;
  if (vendor) {
    const [row] = await sql`SELECT bank_account_last4 FROM vendors WHERE id = ${vendor.id}`;
    onFile = row?.bank_account_last4 ?? null;
  }
  return { vendor, po, duplicateInvoiceId, creditNote: { detected: creditNote, creditedInvoice }, bank: { onInvoice, onFile } };
}

async function poAgainstBooks(d: PoDraft) {
  const vendor = await matchVendor(d.vendorName);
  let existingPoId: string | null = null;
  if (d.poNumber) {
    const [row] = await getSql()`SELECT id FROM purchase_orders WHERE po_number = ${d.poNumber}`;
    existingPoId = row?.id ?? null;
  }
  return { vendor, existingPoId };
}

/** For a goods receipt: the PO it is being recorded against (given) and how the document's lines fit that PO; or,
 *  with no PO given, whether the PO the document cites is on file. */
async function receiptAgainstBooks(d: ReceiptDraft, po: PoSummary | null) {
  if (po) {
    return {
      po: { id: po.id, poNumber: po.poNumber, vendor: po.vendor, status: po.status },
      match: matchReceiptToPo(d, { poNumber: po.poNumber, lines: po.lines }),
    };
  }
  let cited: { id: string; poNumber: string; vendor: string } | null = null;
  if (d.poNumber) {
    const [row] = await getSql()`SELECT p.id, p.po_number, v.name AS vendor FROM purchase_orders p JOIN vendors v ON v.id = p.vendor_id WHERE p.po_number = ${d.poNumber}`;
    cited = row ? { id: row.id, poNumber: row.po_number, vendor: row.vendor } : null;
  }
  return { po: cited, match: null };
}
