import { extract } from "@/lib/agent/extractor";
import { runPipeline } from "@/lib/pipeline/orchestrator";
import { getFrontendInvoice } from "@/lib/api-shapes";
import { createBill } from "@/lib/bills";
import { runInBackground } from "@/lib/background";
import { handle, HttpError, optionalString, readJsonBody, requireString } from "@/lib/http";

export const maxDuration = 60; // extraction may call an LLM, and the pipeline continues after the response

// Next.js ESM interop fallback for pdf-parse
const pdfParse = require("pdf-parse");

const MAX_TEXT_CHARS = 200_000;
const MAX_PDF_BYTES = 8 * 1024 * 1024;

/**
 * POST /api/invoices/ingest — an invoice as a document: { rawText } (plain text, or a
 * data:application/pdf;base64,... URL) and an optional { vendorName } used only when the
 * document's own vendor can't be read.
 *
 * lib/agent/extractor.ts reads the fields (a deterministic template parse first, an LLM only
 * when that is incomplete) and scores its own confidence from real checks: required fields
 * present, lines add up to the subtotal, subtotal + tax equals the total. That extraction is
 * handed to the pipeline so the ledger records WHO read the document and how sure it was, and a
 * low-confidence read is stopped at the layout check (EXC-LAYOUT) for a person instead of being
 * paid on a guess.
 *
 * 422 when nothing usable could be read (no vendor, or no line items), with what was missing.
 * 409 if this vendor already sent this invoice number.
 */
export const POST = handle("POST /api/invoices/ingest", async (req) => {
  const body = await readJsonBody(req);
  let rawText = requireString(body, "rawText", { max: 12_000_000 });
  const vendorFallback = optionalString(body, "vendorName", { max: 200 });

  if (rawText.startsWith("data:application/pdf;base64,")) {
    const buffer = Buffer.from(rawText.slice("data:application/pdf;base64,".length), "base64");
    if (buffer.length > MAX_PDF_BYTES) throw new HttpError(413, `PDF is too large (max ${MAX_PDF_BYTES / 1024 / 1024} MB)`);
    try {
      const parseFunc = pdfParse.default || pdfParse;
      rawText = (await parseFunc(buffer)).text;
    } catch (e) {
      console.error("PDF parse error:", e);
      throw new HttpError(400, "could not read text from this PDF (is it a scan? try pasting the text)");
    }
  }
  if (rawText.length > MAX_TEXT_CHARS) throw new HttpError(413, `document text is too long (max ${MAX_TEXT_CHARS} characters)`);
  if (rawText.trim() === "") throw new HttpError(422, "the document contains no readable text");

  const extraction = await extract(rawText);
  const s = extraction.submission;

  const vendorName = s.vendor_name ?? vendorFallback;
  if (!vendorName) throw new HttpError(422, "could not read a vendor name from this document — pass vendorName");
  if (s.line_items.length === 0) {
    throw new HttpError(422, `could not read any line items from this document (${extraction.fallbackReason ?? "extraction found none"})`);
  }

  const created = await createBill({
    vendorName,
    poNumber: s.po_reference,
    invoiceNumber: s.invoice_number,
    invoiceDate: s.invoice_date,
    currency: s.currency,
    lines: s.line_items.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unit_price })),
    tax: s.tax,
    total: s.total,
    rawSource: rawText,
    strictTotals: false, // a mismatch is already reflected in the extraction's confidence
  });

  runInBackground(`runPipeline(${created.billId})`, () => runPipeline(created.billId, { extraction }));

  const invoice = await getFrontendInvoice(created.billId);
  return Response.json({
    ...invoice,
    extraction: {
      method: extraction.method,
      confidence: s.confidence,
      uncertainFields: s.uncertain_fields,
      fallbackReason: extraction.fallbackReason ?? null,
    },
  }, { status: 201 });
});
