import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getSql } from "@/db/client";
import { HttpError } from "@/lib/http";
import type { Reading } from "@/lib/documents/reader-client";

/**
 * The document intake through its real route handlers and the real (test-schema) database. Only the OCR service is
 * replaced: readDocument returns a reading the real reader produced for a test-set file (eval/documents/readings),
 * so field extraction runs on genuine reader output. No AI call is made (GROQ_API_KEY is unset here), and the
 * background pipeline is captured rather than run, so each test sees exactly what the route handed to it.
 */

vi.mock("@/lib/documents/reader-client", async (original) => ({ ...(await original<typeof import("@/lib/documents/reader-client")>()), readDocument: vi.fn() }));
const pipelineCalls: Array<{ billId: string; opts: any }> = [];
vi.mock("@/lib/background", () => ({ runInBackground: vi.fn((_label: string, _task: () => Promise<unknown>) => undefined) }));
vi.mock("@/lib/pipeline/orchestrator", async (original) => ({
  ...(await original<typeof import("@/lib/pipeline/orchestrator")>()),
  runPipeline: vi.fn(async (billId: string, opts: any) => { pipelineCalls.push({ billId, opts }); }),
}));

const { readDocument } = await import("@/lib/documents/reader-client");
const readRoute = await import("@/app/api/documents/read/route");
const docRoute = await import("@/app/api/documents/[id]/route");
const fileRoute = await import("@/app/api/documents/[id]/file/route");
const saveRoute = await import("@/app/api/invoices/from-document/route");
const poRoute = await import("@/app/api/purchase-orders/route");
const { runExtractStage } = await import("@/lib/pipeline/orchestrator");
const { runInBackground } = await import("@/lib/background");

const ROOT = join(process.cwd(), "eval", "documents");
function saved(folder: string, layout: string, form: string): { bytes: Buffer; reading: Reading } {
  const bytes = readFileSync(join(ROOT, folder, layout, form));
  const reading = JSON.parse(readFileSync(join(ROOT, "readings", `${createHash("sha256").update(bytes).digest("hex")}.json`), "utf8"));
  return { bytes, reading };
}

/** The same file with a different byte at the end: a different upload (new hash) with the same content. */
const variant = (bytes: Buffer, n: number) => Buffer.concat([bytes, Buffer.from(`\n%variant-${n}-${Date.now()}`)]);

function upload(bytes: Buffer, filename: string, purpose = "invoice", type = "application/pdf"): Request {
  const form = new FormData();
  form.append("purpose", purpose);
  form.append("file", new Blob([bytes], { type }), filename);
  return new Request("http://test/api/documents/read", { method: "POST", body: form });
}
const json = (body: unknown) => new Request("http://test/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function readAs(folder: string, layout: string, form: string, n: number, purpose = "invoice") {
  const { bytes, reading } = saved(folder, layout, form);
  vi.mocked(readDocument).mockResolvedValueOnce(reading);
  const res = await readRoute.POST(upload(variant(bytes, n), `${layout}-${form}`, purpose), undefined as never);
  return { res, body: await res.json() };
}

function reviewedInvoice(x: any, overrides: Record<string, unknown> = {}) {
  const s = x.submission;
  return {
    vendorName: s.vendor_name, invoiceNumber: `${s.invoice_number}-${Math.random().toString(36).slice(2, 7)}`, invoiceDate: s.invoice_date,
    poNumber: s.po_reference, currency: s.currency,
    lines: s.line_items.map((l: any) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unit_price })),
    charges: s.other_charges ?? [], taxLines: s.tax_lines ?? [], discount: s.discount ?? 0, roundOff: s.round_off ?? 0, total: s.total,
    ...overrides,
  };
}

beforeAll(() => vi.stubEnv("GROQ_API_KEY", ""));
beforeEach(() => { vi.mocked(readDocument).mockReset(); pipelineCalls.length = 0; });

describe("POST /api/documents/read", () => {
  it("reads a document, stores the original and the reading, and says what the books know", async () => {
    const { res, body } = await readAs("invoices", "tally_gst", "digital.pdf", 1);
    expect(res.status).toBe(201);
    expect(body.extraction.method).toBe("template");
    expect(body.extraction.submission).toMatchObject({ invoice_number: "SGIS/2026-27/0412", total: 12434, round_off: 0.34, currency: "INR" });
    expect(body.books.po).toMatchObject({ number: "PO-2026-0871" });
    const [row] = await getSql()`SELECT purpose, source_kind, byte_size, length(content) AS stored FROM source_documents WHERE id = ${body.documentId}`;
    expect(row).toMatchObject({ purpose: "invoice", source_kind: "digital_pdf" });
    expect(Number(row.stored)).toBe(row.byte_size);
  });

  it("the same file uploaded again is not read again: the earlier reading is returned, marked as already uploaded", async () => {
    const { bytes, reading } = saved("invoices", "us_invoice", "digital.pdf");
    const unique = variant(bytes, 2);
    vi.mocked(readDocument).mockResolvedValueOnce(reading);
    const first = await readRoute.POST(upload(unique, "a.pdf"), undefined as never);
    const second = await readRoute.POST(upload(unique, "a-again.pdf"), undefined as never);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const b2 = await second.json();
    expect(b2.documentId).toBe((await first.json()).documentId);
    expect(b2.alreadyUploaded).toMatchObject({ invoiceId: null });
    expect(readDocument).toHaveBeenCalledTimes(1);
  });

  it("refuses an unsupported file type (415), an empty file (400) and a bad purpose (400) before reading anything", async () => {
    expect((await readRoute.POST(upload(Buffer.from("MZ..."), "setup.exe"), undefined as never)).status).toBe(415);
    expect((await readRoute.POST(upload(Buffer.alloc(0), "empty.pdf"), undefined as never)).status).toBe(400);
    expect((await readRoute.POST(upload(Buffer.from("%PDF-1.4"), "x.pdf", "receipt"), undefined as never)).status).toBe(400);
    expect(readDocument).not.toHaveBeenCalled();
  });

  it("when the document reader is not running, says so (503) instead of returning an empty invoice", async () => {
    vi.mocked(readDocument).mockRejectedValueOnce(new HttpError(503, "the document reader is not running, so documents cannot be read right now (start it with `npm run reader`)"));
    const res = await readRoute.POST(upload(variant(Buffer.from("%PDF-1.4 x"), 3), "x.pdf"), undefined as never);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/not running/);
  });

  it("pasted text is read without the reader", async () => {
    const res = await readRoute.POST(json({ purpose: "invoice", text: `Vendor: Paste Test Co\nInvoice Number: PT-${Date.now()}\nInvoice Date: 2026-10-01\nLine Items:\n1. Widget\n   Qty: 2\n   Unit Price: $5.00\n---\nSubtotal: $10.00\nTotal: $10.00` }), undefined as never);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.reading.sourceKind).toBe("text");
    expect(readDocument).not.toHaveBeenCalled();
  });
});

describe("GET /api/documents/:id/file", () => {
  it("shows a PDF or image inline, but never an HTML or Word file (always a download, nosniff)", async () => {
    const pdf = await readAs("invoices", "zoho_igst", "digital.pdf", 4);
    const r1 = await fileRoute.GET(new Request("http://test"), ctx(pdf.body.documentId));
    expect(r1.headers.get("content-type")).toBe("application/pdf");
    expect(r1.headers.get("content-disposition")).toMatch(/^inline/);
    expect(r1.headers.get("x-content-type-options")).toBe("nosniff");

    const { reading } = saved("invoices", "service_bill", "document.docx");
    for (const [name, type] of [["evil.html", "text/html"], ["bill.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]]) {
      vi.mocked(readDocument).mockResolvedValueOnce({ ...reading, media_type: type });
      const read = await (await readRoute.POST(upload(Buffer.from(`<html>${name}${Date.now()}</html>`), name, "invoice", type), undefined as never)).json();
      const r = await fileRoute.GET(new Request("http://test"), ctx(read.documentId));
      expect(r.headers.get("content-type")).toBe("application/octet-stream");
      expect(r.headers.get("content-disposition")).toMatch(/^attachment/);
    }
    expect((await fileRoute.GET(new Request("http://test"), ctx("no-such-document"))).status).toBe(404);
  });

  it("GET /api/documents/:id returns how it was read, without the page layout", async () => {
    const { body } = await readAs("invoices", "uk_vat", "photo.jpg", 5);
    const res = await docRoute.GET(new Request("http://test"), ctx(body.documentId));
    const doc = await res.json();
    expect(doc.reading).toMatchObject({ sourceKind: "image", ocrUsed: true });
    expect(doc.reading.layout).toBeUndefined();
  });
});

describe("POST /api/invoices/from-document", () => {
  it("saves the checked invoice: totals must add up, round off becomes the adjustment, the document is linked", async () => {
    const { body } = await readAs("invoices", "tally_gst", "scan_clean.pdf", 6);
    const res = await saveRoute.POST(json({ documentId: body.documentId, reviewerName: "Asha", invoice: reviewedInvoice(body.extraction) }), undefined as never);
    expect(res.status).toBe(201);
    const inv = await res.json();
    const [bill] = await getSql()`SELECT subtotal, tax_total, adjustment_total, total_amount, source_document_id FROM vendor_bills WHERE id = ${inv.id}`;
    expect(bill).toMatchObject({ subtotal: 10537, tax_total: 1896.66, adjustment_total: 0.34, total_amount: 12434, source_document_id: body.documentId });
    expect(runInBackground).toHaveBeenCalled();
  });

  it("records the person's check on the trail: who saved it, how the machine read it, and every field they corrected", async () => {
    const { body } = await readAs("invoices", "us_invoice", "scan_messy.pdf", 7);
    const invoice = reviewedInvoice(body.extraction, { vendorName: "Bayside Industrial Supply Company" });
    const res = await saveRoute.POST(json({ documentId: body.documentId, reviewerName: "Ravi", invoice }), undefined as never);
    expect(res.status).toBe(201);
    const inv = await res.json();
    expect(inv.corrections.map((c: any) => c.field)).toEqual(expect.arrayContaining(["vendor", "invoice number"]));

    // the extraction result the route hands the pipeline, written to the trail as the extract decision
    const call = vi.mocked(runInBackground).mock.calls.at(-1)!;
    await call[1](); // runs the (mocked) runPipeline, which captures its arguments
    const { opts } = pipelineCalls.at(-1)!;
    const decision = await runExtractStage(inv.id, opts.extraction);
    expect(decision.agentId).toBe("human:Ravi");
    expect(decision.confidence).toBe(1);
    const claims = (decision.claims ?? []).map((c: any) => c.text).join(" | ");
    expect(claims).toMatch(/Read from us_invoice-scan_messy\.pdf \(scanned pdf, OCR confidence \d+%\) by the layout rules/);
    expect(claims).toMatch(/Checked against the document and saved by Ravi/);
    expect(claims).toMatch(/Corrected by Ravi: vendor read as "Bayside Industrial Supply Co\.", saved as "Bayside Industrial Supply Company"/);
  });

  it("refuses figures that do not add up (422), a second save of the same document (409) and a PO document (400)", async () => {
    const { body } = await readAs("invoices", "uk_vat", "digital.pdf", 8);
    const bad = await saveRoute.POST(json({ documentId: body.documentId, reviewerName: "Asha", invoice: reviewedInvoice(body.extraction, { total: 300 }) }), undefined as never);
    expect(bad.status).toBe(422);
    expect((await bad.json()).error).toMatch(/does not equal/);

    const ok = await saveRoute.POST(json({ documentId: body.documentId, reviewerName: "Asha", invoice: reviewedInvoice(body.extraction) }), undefined as never);
    expect(ok.status).toBe(201);
    const again = await saveRoute.POST(json({ documentId: body.documentId, reviewerName: "Asha", invoice: reviewedInvoice(body.extraction) }), undefined as never);
    expect(again.status).toBe(409);

    const po = await readAs("purchase_orders", "po_us", "digital.pdf", 9, "purchase_order");
    const wrong = await saveRoute.POST(json({ documentId: po.body.documentId, reviewerName: "Asha", invoice: reviewedInvoice(body.extraction) }), undefined as never);
    expect(wrong.status).toBe(400);
  });

  it("needs a reviewer name: the person who checked it is recorded", async () => {
    const { body } = await readAs("invoices", "plain_bill", "digital.pdf", 10);
    const res = await saveRoute.POST(json({ documentId: body.documentId, invoice: reviewedInvoice(body.extraction) }), undefined as never);
    expect(res.status).toBe(400);
  });
});

describe("purchase orders from documents", () => {
  it("a PO read from a document is saved linked to it, and the same document cannot become a second PO", async () => {
    const { body } = await readAs("purchase_orders", "po_indian", "photo.jpg", 11, "purchase_order");
    expect(body.extraction).toMatchObject({ vendorName: "Shree Ganesh Industrial Supplies", poNumber: "PO-2026-0871" });
    const d = body.extraction;
    const make = (n: string) => json({ vendor: d.vendorName, poNumber: n, orderDate: d.orderDate, currency: d.currency, sourceDocumentId: body.documentId,
      items: d.lines.map((l: any) => ({ description: l.description, qty: l.quantity, rate: l.unitPrice })) });
    const first = await poRoute.POST(make(`PO-DOC-${Date.now()}`), undefined as never);
    expect(first.status).toBe(201);
    const [po] = await getSql()`SELECT source_document_id FROM purchase_orders WHERE id = ${(await first.json()).poId}`;
    expect(po.source_document_id).toBe(body.documentId);
    expect((await poRoute.POST(make(`PO-DOC-${Date.now()}-2`), undefined as never)).status).toBe(409);
  });
});
