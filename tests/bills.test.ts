import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";

// The routes start the pipeline in the background; these tests are about intake, so stub that out.
const started: string[] = [];
vi.mock("@/lib/background", () => ({ runInBackground: (label: string) => { started.push(label); } }));
vi.mock("@/lib/pipeline/orchestrator", () => ({ runPipeline: vi.fn() }));

import { getSql } from "@/db/client";
import { normalizeBillInput, createBill } from "@/lib/bills";
import { POST as createInvoice, GET as listInvoices } from "@/app/api/invoices/route";
import { POST as ingest } from "@/app/api/invoices/ingest/route";

const sql = getSql();
const TAG = "BILL-" + randomUUID().slice(0, 6);
const post = (handler: any, body: unknown) => handler(new Request("http://t/x", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), undefined) as Promise<Response>;

const lines = [{ description: "Widget", quantity: 50, unitPrice: 12 }, { description: "Bolt", quantity: 200, unitPrice: 0.75 }]; // 600 + 150 = 750

describe("normalizeBillInput", () => {
  it("lines are the source of truth for the subtotal; tax and stated total are kept, not dropped", () => {
    const n = normalizeBillInput({ lines, tax: 60, total: 810, strictTotals: true });
    expect(n).toMatchObject({ subtotal: 750, tax: 60, total: 810, currency: "USD" });
  });
  it("without a stated total, total = lines + tax", () => {
    expect(normalizeBillInput({ lines, tax: 60, strictTotals: true }).total).toBe(810);
    expect(normalizeBillInput({ lines, strictTotals: true }).total).toBe(750);
  });
  it("API callers: a stated total that is not lines + tax is rejected with the arithmetic", () => {
    expect(() => normalizeBillInput({ lines, tax: 60, total: 800, strictTotals: true }))
      .toThrow(/stated total 800\.00 does not equal the line items \(750\.00\) plus tax \(60\.00\) = 810\.00/);
  });
  it("documents: the same mismatch is kept as stated (the extractor already lowered its confidence)", () => {
    expect(normalizeBillInput({ lines, tax: 60, total: 800, strictTotals: false }).total).toBe(800);
  });
  it("rejects empty, non-numeric and negative input at the edge", () => {
    expect(() => normalizeBillInput({ lines: [], strictTotals: true })).toThrow(/at least one line/);
    expect(() => normalizeBillInput({ lines: [{ description: "x", quantity: 0, unitPrice: 5 }], strictTotals: true })).toThrow(/quantity must be at least/);
    expect(() => normalizeBillInput({ lines: [{ description: "x", quantity: 1, unitPrice: NaN }], strictTotals: true })).toThrow(/unit price must be a number/);
    expect(() => normalizeBillInput({ lines: [{ description: "  ", quantity: 1, unitPrice: 1 }], strictTotals: true })).toThrow(/description is required/);
    expect(() => normalizeBillInput({ lines, tax: -1, strictTotals: true })).toThrow(/tax must be at least 0/);
    expect(() => normalizeBillInput({ lines, invoiceDate: "10/08/2026", strictTotals: true })).toThrow(/YYYY-MM-DD/);
    expect(() => normalizeBillInput({ lines, currency: "dollars", strictTotals: true })).toThrow(/3-letter code/);
    expect(() => normalizeBillInput({ lines: [{ description: "free", quantity: 1, unitPrice: 0 }], strictTotals: true })).toThrow(/greater than zero/);
  });
});

describe("createBill", () => {
  it("creates the vendor, bill and lines together, and stores the tax", async () => {
    const out = await createBill({ vendorName: `${TAG} Supplies`, lines, tax: 60, invoiceNumber: `${TAG}-1`, strictTotals: true });
    expect(out.vendorCreated).toBe(true);
    const [bill] = await sql`SELECT subtotal, tax_total, total_amount FROM vendor_bills WHERE id = ${out.billId}`;
    expect([Number(bill.subtotal), Number(bill.tax_total), Number(bill.total_amount)]).toEqual([750, 60, 810]);
    expect(await sql`SELECT 1 FROM vendor_bill_lines WHERE vendor_bill_id = ${out.billId}`).toHaveLength(2);
  });

  it("answers 409 for an invoice number this vendor already sent, and leaves nothing half-created", async () => {
    const vendorName = `${TAG} Dup Co`;
    await createBill({ vendorName, lines, invoiceNumber: `${TAG}-D`, strictTotals: true });
    const before = (await sql`SELECT count(*)::int AS n FROM vendor_bills`)[0].n;
    await expect(createBill({ vendorName, lines, invoiceNumber: `${TAG}-D`, strictTotals: true })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already received/) });
    expect((await sql`SELECT count(*)::int AS n FROM vendor_bills`)[0].n).toBe(before);
  });

  it("a failure partway through (bad PO lookup is fine, bad vendor id is not) rolls back the vendor too", async () => {
    await expect(createBill({ vendorId: randomUUID(), lines, strictTotals: true })).rejects.toMatchObject({ status: 404 });
  });
});

describe("POST /api/invoices", () => {
  it("201 with the invoice in its first state, and the pipeline started in the background", async () => {
    started.length = 0;
    const res = await post(createInvoice, { vendor: `${TAG} API Co`, invoiceNumber: `${TAG}-API`, items: [{ description: "Consulting", qty: 2, rate: 400 }], tax: 80, totalAmount: 880 });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ amount: 880, currency: "USD", rawStatus: "processing", state: "processing" });
    expect(started).toHaveLength(1);
  });
  it("400 on malformed JSON and on a missing items array; 422 on a total that does not add up; 409 on a duplicate", async () => {
    expect((await post(createInvoice, "{oops")).status).toBe(400);
    expect((await post(createInvoice, { vendor: "X" })).status).toBe(400);
    expect((await post(createInvoice, { vendor: `${TAG} Bad Co`, items: [{ description: "a", qty: 1, rate: 100 }], totalAmount: 90 })).status).toBe(422);
    const ok = { vendor: `${TAG} Twice Co`, invoiceNumber: `${TAG}-T`, items: [{ description: "a", qty: 1, rate: 100 }] };
    expect((await post(createInvoice, ok)).status).toBe(201);
    const dup = await post(createInvoice, ok);
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toMatch(/already received/);
  });
  it("GET validates its limit", async () => {
    expect((await listInvoices(new Request("http://t/api/invoices?limit=0"), undefined as never)).status).toBe(400);
    expect((await listInvoices(new Request("http://t/api/invoices?limit=5000"), undefined as never)).status).toBe(400);
    const ok = await listInvoices(new Request("http://t/api/invoices?limit=3"), undefined as never);
    expect(ok.status).toBe(200);
    expect((await ok.json()).length).toBeLessThanOrEqual(3);
  });
});

describe("POST /api/invoices/ingest", () => {
  const doc = (extra = "") => `
Northwind Parts Ltd.
INVOICE
Invoice #: ${TAG}-ING${extra}
Date: 2026-10-02
PO Reference: PO-X

Line Items:
1. Steel Widget Bracket - Qty 50 - Unit Price $12.00
2. Zinc Plated Bolt M8x40 - Qty 200 - Unit Price $0.75

Subtotal: $750.00
Tax: $60.00
Total: $810.00
Currency: USD
`.trim();

  it("reads a document, stores the invoice's OWN total including tax, and reports how it was read", async () => {
    started.length = 0;
    const res = await post(ingest, { rawText: doc() });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.amount).toBe(810); // the old route stored 750 and dropped the tax
    expect(body.vendor).toBe("Northwind Parts Ltd.");
    expect(body.extraction).toMatchObject({ method: "template", confidence: 0.95, fallbackReason: null });
    expect(started).toHaveLength(1);
    const [row] = await sql`SELECT tax_total, total_amount, raw_source FROM vendor_bills WHERE id = ${body.id}`;
    expect([Number(row.tax_total), Number(row.total_amount)]).toEqual([60, 810]);
    expect(row.raw_source).toContain("Steel Widget Bracket");
  });

  it("409 when the same document is submitted again", async () => {
    const res = await post(ingest, { rawText: doc("-B") });
    expect(res.status).toBe(201);
    expect((await post(ingest, { rawText: doc("-B") })).status).toBe(409);
  });

  it("422, with the reason, when nothing usable can be read — instead of creating a junk invoice and vendor", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    const vendorsBefore = (await sql`SELECT count(*)::int AS n FROM vendors`)[0].n;
    const res = await post(ingest, { rawText: "scanned page, no structure at all" });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/could not read any line items/);
    const noLines = await post(ingest, { rawText: "Some Vendor\nInvoice #: X-1\nDate: 2026-10-01\nTotal: $50.00", vendorName: "Some Vendor" });
    expect(noLines.status).toBe(422);
    expect((await noLines.json()).error).toMatch(/could not read any line items/);
    expect((await sql`SELECT count(*)::int AS n FROM vendors`)[0].n).toBe(vendorsBefore);
    vi.unstubAllEnvs();
  });

  it("400 for a missing body field", async () => {
    expect((await post(ingest, {})).status).toBe(400);
    expect((await post(ingest, { rawText: "   " })).status).toBe(400);
  });
});
