import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";

// The invoice routes start the pipeline in the background; these tests are about the PO side, so stub that out.
vi.mock("@/lib/background", () => ({ runInBackground: () => {} }));
vi.mock("@/lib/pipeline/orchestrator", () => ({ runPipeline: vi.fn() }));

import { getSql } from "@/db/client";
import { createBill } from "@/lib/bills";
import { runMatchStage } from "@/lib/pipeline/match-stage";
import { createPurchaseOrder, recordReceipt, listPurchaseOrders, normalizePurchaseOrder, normalizeReceipt } from "@/lib/purchase-orders";
import { POST as postPo, GET as getPos } from "@/app/api/purchase-orders/route";
import { POST as postReceipt } from "@/app/api/purchase-orders/[id]/receipts/route";
import { POST as parsePo } from "@/app/api/purchase-orders/parse/route";
import { POST as ingest } from "@/app/api/invoices/ingest/route";
import { makePdfDataUrl } from "./helpers/make-pdf";

const sql = getSql();
const TAG = "PO-" + randomUUID().slice(0, 6);
const req = (body: unknown) => new Request("http://t/x", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

const lines = [{ description: "Widget", quantity: 50, unitPrice: 12 }, { description: "Bolt", quantity: 200, unitPrice: 0.75 }]; // 600 + 150

describe("normalizePurchaseOrder", () => {
  it("normalizes a valid PO: numbered lines, default unit of measure and currency, the total", () => {
    const n = normalizePurchaseOrder({ poNumber: "  PO-1 ", lines }, "2026-10-10");
    expect(n).toMatchObject({ poNumber: "PO-1", orderDate: "2026-10-10", currency: "USD", total: 750 });
    expect(n.lines.map((l) => [l.lineNumber, l.uom])).toEqual([[1, "each"], [2, "each"]]);
  });
  it("rejects bad input at the edge", () => {
    expect(() => normalizePurchaseOrder({ poNumber: " ", lines })).toThrow(/needs a number/);
    expect(() => normalizePurchaseOrder({ poNumber: "P", lines: [] })).toThrow(/at least one line/);
    expect(() => normalizePurchaseOrder({ poNumber: "P", lines: [{ description: "x", quantity: 0, unitPrice: 1 }] })).toThrow(/quantity must be greater than 0/);
    expect(() => normalizePurchaseOrder({ poNumber: "P", lines: [{ description: "x", quantity: 1, unitPrice: -1 }] })).toThrow(/unit price must be at least 0/);
    expect(() => normalizePurchaseOrder({ poNumber: "P", lines: [{ description: "x", quantity: NaN, unitPrice: 1 }] })).toThrow(/quantity must be a number/);
    expect(() => normalizePurchaseOrder({ poNumber: "P", lines: [{ description: " ", quantity: 1, unitPrice: 1 }] })).toThrow(/description is required/);
    expect(() => normalizePurchaseOrder({ poNumber: "P", lines, orderDate: "10/10/2026" })).toThrow(/YYYY-MM-DD/);
    expect(() => normalizePurchaseOrder({ poNumber: "P", lines, orderDate: "2026-13-45" })).toThrow(/real date/);
    expect(() => normalizePurchaseOrder({ poNumber: "P", lines, currency: "dollars" })).toThrow(/3-letter code/);
  });
});

describe("normalizeReceipt", () => {
  const po = [{ lineNumber: 1, quantity: 50 }, { lineNumber: 2, quantity: 200 }];
  it("receivedInFull receives every line at its ordered quantity", () => {
    expect(normalizeReceipt({ inFull: true }, po, "2026-10-10")).toMatchObject({ lines: po, condition: "accepted", receiptDate: "2026-10-10" });
  });
  it("explicit lines win over inFull, and may be partial", () => {
    expect(normalizeReceipt({ inFull: true, lines: [{ lineNumber: 2, quantity: 120 }] }, po).lines).toEqual([{ lineNumber: 2, quantity: 120 }]);
  });
  it("rejects a receipt that says nothing, an unknown or repeated line, a bad quantity or condition", () => {
    expect(() => normalizeReceipt({}, po)).toThrow(/say what was received/);
    expect(() => normalizeReceipt({ lines: [{ lineNumber: 3, quantity: 1 }] }, po)).toThrow(/there is no PO line 3 \(this PO has lines 1-2\)/);
    expect(() => normalizeReceipt({ lines: [{ lineNumber: 1, quantity: 1 }, { lineNumber: 1, quantity: 2 }] }, po)).toThrow(/appears twice/);
    expect(() => normalizeReceipt({ lines: [{ lineNumber: 1, quantity: 0 }] }, po)).toThrow(/quantity must be greater than 0/);
    expect(() => normalizeReceipt({ inFull: true, condition: "lost" as any }, po)).toThrow(/condition must be one of/);
  });
});

describe("createPurchaseOrder", () => {
  it("creates the vendor, PO, lines and receipt together", async () => {
    const out = await createPurchaseOrder({ vendorName: `${TAG} Supplies`, poNumber: `${TAG}-1`, lines, receipt: { inFull: true, receiverName: "Dana" } });
    expect(out).toMatchObject({ vendorCreated: true, receiptId: expect.any(String) });
    const [po] = await sql`SELECT status, po_type, currency FROM purchase_orders WHERE id = ${out.poId}`;
    expect(po).toMatchObject({ status: "open", po_type: "standard", currency: "USD" });
    expect(await sql`SELECT 1 FROM purchase_order_lines WHERE po_id = ${out.poId}`).toHaveLength(2);
    const rec = await sql`SELECT grl.qty_received FROM goods_receipt_lines grl JOIN goods_receipts gr ON gr.id = grl.goods_receipt_id WHERE gr.po_id = ${out.poId} ORDER BY grl.qty_received`;
    expect(rec.map((r) => Number(r.qty_received))).toEqual([50, 200]);
  });

  it("409 for a PO number already used, and nothing is half-created", async () => {
    await createPurchaseOrder({ vendorName: `${TAG} Dup Co`, poNumber: `${TAG}-D`, lines });
    const before = (await sql`SELECT count(*)::int AS n FROM purchase_orders`)[0].n;
    await expect(createPurchaseOrder({ vendorName: `${TAG} Other Co`, poNumber: `${TAG}-D`, lines })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already exists/) });
    expect((await sql`SELECT count(*)::int AS n FROM purchase_orders`)[0].n).toBe(before);
    expect(await sql`SELECT 1 FROM vendors WHERE name = ${TAG + " Other Co"}`).toHaveLength(0); // the vendor was rolled back too
  });

  it("the same PO submitted twice at once makes exactly one", async () => {
    const input = { vendorName: `${TAG} Race Co`, poNumber: `${TAG}-RACE`, lines };
    const results = await Promise.allSettled([createPurchaseOrder(input), createPurchaseOrder(input)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { status: 409 } });
  });

  it("a receipt that does not fit the lines refuses the whole PO (validated before anything is written)", async () => {
    await expect(createPurchaseOrder({ vendorName: `${TAG} Bad Co`, poNumber: `${TAG}-BAD`, lines, receipt: { lines: [{ lineNumber: 9, quantity: 1 }] } })).rejects.toMatchObject({ status: 400 });
    expect(await sql`SELECT 1 FROM purchase_orders WHERE po_number = ${TAG + "-BAD"}`).toHaveLength(0);
  });
});

describe("recordReceipt", () => {
  const make = (n: string) => createPurchaseOrder({ vendorName: `${TAG} R${n} Co`, poNumber: `${TAG}-R${n}`, lines });

  it("records goods received; a partial receipt and a later one add up", async () => {
    const po = await make("1");
    await recordReceipt(po.poId, { lines: [{ lineNumber: 1, quantity: 20 }], receiptDate: "2026-10-01" });
    await recordReceipt(po.poId, { lines: [{ lineNumber: 1, quantity: 30 }], receiptDate: "2026-10-02" });
    const listed = (await listPurchaseOrders(200)).find((p) => p.id === po.poId)!;
    expect(listed.lines.map((l) => [l.ordered, l.received])).toEqual([[50, 50], [200, 0]]);
    expect(listed.receivedInFull).toBe(false);
  });

  it("only ACCEPTED goods count as received: a damaged delivery is recorded but does not clear the line", async () => {
    const po = await make("2");
    await recordReceipt(po.poId, { inFull: true, condition: "damaged" });
    const listed = (await listPurchaseOrders(200)).find((p) => p.id === po.poId)!;
    expect(listed.lines.map((l) => l.received)).toEqual([0, 0]);
    expect(listed.receivedInFull).toBe(false);
  });

  it("409 for the exact same receipt twice (a double click must not double the goods received)", async () => {
    const po = await make("3");
    const r = { inFull: true, receiptDate: "2026-10-03", receiverName: "Dana" };
    await recordReceipt(po.poId, r);
    await expect(recordReceipt(po.poId, r)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already recorded/) });
    // a different date is a different delivery
    await expect(recordReceipt(po.poId, { ...r, receiptDate: "2026-10-04" })).resolves.toBeTruthy();
  });

  it("two identical receipts submitted at once record exactly one", async () => {
    const po = await make("4");
    const r = { inFull: true, receiptDate: "2026-10-05" };
    const results = await Promise.allSettled([recordReceipt(po.poId, r), recordReceipt(po.poId, r)]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((await sql`SELECT count(*)::int AS n FROM goods_receipts WHERE po_id = ${po.poId}`)[0].n).toBe(1);
  });

  it("404 for an unknown PO, 409 for a closed one, 400 for a line the PO does not have", async () => {
    await expect(recordReceipt(randomUUID(), { inFull: true })).rejects.toMatchObject({ status: 404 });
    const closed = await make("5");
    await sql`UPDATE purchase_orders SET status = 'closed' WHERE id = ${closed.poId}`;
    await expect(recordReceipt(closed.poId, { inFull: true })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/closed/) });
    const open = await make("6");
    await expect(recordReceipt(open.poId, { lines: [{ lineNumber: 7, quantity: 1 }] })).rejects.toMatchObject({ status: 400 });
  });
});

describe("a PO and receipt entered here are what an invoice is matched against", () => {
  it("an invoice from the same vendor typed in different case finds the PO, and a full match passes", async () => {
    await createPurchaseOrder({ vendorName: `${TAG} Match Co`, poNumber: `${TAG}-M1`, lines, receipt: { inFull: true, receiptDate: "2026-10-01" } });
    const bill = await createBill({ vendorName: `${TAG} MATCH  co`, poNumber: `${TAG}-M1`, invoiceNumber: `${TAG}-I1`, invoiceDate: "2026-10-05", lines, strictTotals: true });
    expect(bill.vendorCreated).toBe(false); // case and spacing do not make a second vendor
    const r = await runMatchStage(bill.billId);
    expect(r.findings).toEqual([]);
    expect(r.combined.overallAction).toBe("auto_approve");
    expect(r.detail.poReference).toBe(`${TAG}-M1`);
  });

  it("billing more than was received is caught", async () => {
    await createPurchaseOrder({ vendorName: `${TAG} Short Co`, poNumber: `${TAG}-M2`, lines, receipt: { lines: [{ lineNumber: 1, quantity: 20 }, { lineNumber: 2, quantity: 200 }], receiptDate: "2026-10-01" } });
    const bill = await createBill({ vendorName: `${TAG} Short Co`, poNumber: `${TAG}-M2`, invoiceNumber: `${TAG}-I2`, invoiceDate: "2026-10-05", lines, strictTotals: true });
    const r = await runMatchStage(bill.billId);
    expect(r.combined.overallAction).not.toBe("auto_approve");
    expect(r.findings.length).toBeGreaterThan(0);
  });

  it("an invoice that arrives before any receipt is held (nothing was received yet)", async () => {
    await createPurchaseOrder({ vendorName: `${TAG} NoRcv Co`, poNumber: `${TAG}-M3`, lines });
    const bill = await createBill({ vendorName: `${TAG} NoRcv Co`, poNumber: `${TAG}-M3`, invoiceNumber: `${TAG}-I3`, invoiceDate: "2026-10-05", lines, strictTotals: true });
    const r = await runMatchStage(bill.billId);
    expect(r.findings.some((f) => f.code === "EXC-BEFORE_RCV")).toBe(true);
    expect(r.combined.overallAction).not.toBe("auto_approve");
  });
});

describe("routes", () => {
  it("POST /api/purchase-orders: 201, then 409 for the same number, 400 for malformed input", async () => {
    const body = { vendor: `${TAG} Route Co`, poNumber: `${TAG}-RT`, items: [{ description: "Widget", qty: 5, rate: 10 }], receipt: { receivedInFull: true } };
    const ok = await postPo(req(body), undefined);
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ poNumber: `${TAG}-RT`, receiptId: expect.any(String) });
    expect((await postPo(req(body), undefined)).status).toBe(409);
    expect((await postPo(req("{oops"), undefined)).status).toBe(400);
    expect((await postPo(req({ vendor: "X", poNumber: "Y" }), undefined)).status).toBe(400);
    expect((await postPo(req({ ...body, poNumber: `${TAG}-RT2`, receipt: "yes" }), undefined)).status).toBe(400);
  });

  it("POST /api/purchase-orders/:id/receipts and GET /api/purchase-orders", async () => {
    const created = await (await postPo(req({ vendor: `${TAG} Route2 Co`, poNumber: `${TAG}-RT3`, items: [{ description: "Widget", qty: 5, rate: 10 }] }), undefined)).json();
    const rec = await postReceipt(req({ lines: [{ line: 1, qty: 5 }] }), { params: Promise.resolve({ id: created.poId }) });
    expect(rec.status).toBe(201);
    expect((await postReceipt(req({}), { params: Promise.resolve({ id: created.poId }) })).status).toBe(400);
    expect((await postReceipt(req({ receivedInFull: true }), { params: Promise.resolve({ id: randomUUID() }) })).status).toBe(404);
    const list = await (await getPos(new Request("http://t/x?limit=200"), undefined)).json();
    expect(list.find((p: any) => p.id === created.poId)).toMatchObject({ poNumber: `${TAG}-RT3`, receivedInFull: true, total: 50 });
    expect((await getPos(new Request("http://t/x?limit=0"), undefined)).status).toBe(400);
  });

  it("POST /api/purchase-orders/parse reads a PO document (text and a real PDF) into a draft and writes nothing", async () => {
    const text = `Purchase Order\nVendor: Northwind Parts Ltd.\nPO Number: PO-2026-7001\nOrder Date: 2026-10-01\n\nLine Items:\n1. Industrial Bearing Set\n   Qty: 12\n   Unit Price: $145.00\n`;
    const before = (await sql`SELECT count(*)::int AS n FROM purchase_orders`)[0].n;
    const draft = await (await parsePo(req({ rawText: text }), undefined)).json();
    expect(draft).toMatchObject({ vendorName: "Northwind Parts Ltd.", poNumber: "PO-2026-7001", orderDate: "2026-10-01", missing: [], lines: [{ description: "Industrial Bearing Set", quantity: 12, unitPrice: 145 }] });

    const pdf = await makePdfDataUrl((doc) => {
      doc.fontSize(12).text("PURCHASE ORDER").text("Supplier: Acme Supply Co.").text("PO No: PO-55").text("Date: 2026-09-01").text("Description Qty Unit Price Amount");
      doc.text("Steel Bracket 10 $5.00 $50.00").text("Subtotal $50.00");
    });
    expect(await (await parsePo(req({ rawText: pdf }), undefined)).json()).toMatchObject({ vendorName: "Acme Supply Co.", poNumber: "PO-55", orderDate: "2026-09-01", lines: [{ description: "Steel Bracket", quantity: 10, unitPrice: 5 }] });

    const unreadable = await (await parsePo(req({ rawText: "just some words" }), undefined)).json();
    expect(unreadable.missing).toEqual(expect.arrayContaining(["the PO number", "the line items"]));
    expect((await sql`SELECT count(*)::int AS n FROM purchase_orders`)[0].n).toBe(before);
    expect((await parsePo(req({}), undefined)).status).toBe(400);
  });
});

describe("an invoice that cites a PO it cannot match says why", () => {
  const invoiceText = (vendor: string, number: string, po: string) =>
    `${vendor}
INVOICE
Invoice Number: ${number}
Invoice Date: 2026-10-05
Purchase Order: ${po}

Line Items:
1. Widget
   Qty: 5
   Unit Price: $10.00
---
Subtotal: $50.00
Total Amount Due: $50.00
`;

  it("names the vendor the PO belongs to when the vendor names differ", async () => {
    await createPurchaseOrder({ vendorName: `${TAG} Acme Corporation`, poNumber: `${TAG}-X1`, lines });
    const res = await ingest(req({ rawText: invoiceText(`${TAG} Acme Corp`, `${TAG}-XI1`, `${TAG}-X1`) }), undefined);
    const body = await res.json();
    expect(body.poNumber).toBe("Non-PO");
    expect(body.extraction).toMatchObject({ poReference: `${TAG}-X1`, poOnFileFor: `${TAG} Acme Corporation` });
  });

  it("poOnFileFor is null when no PO has that number, and when the PO did match", async () => {
    const none = await (await ingest(req({ rawText: invoiceText(`${TAG} Solo Co`, `${TAG}-XI2`, `${TAG}-NOPE`) }), undefined)).json();
    expect(none.extraction).toMatchObject({ poReference: `${TAG}-NOPE`, poOnFileFor: null });

    await createPurchaseOrder({ vendorName: `${TAG} Same Co`, poNumber: `${TAG}-X3`, lines });
    const matched = await (await ingest(req({ rawText: invoiceText(`${TAG} SAME co`, `${TAG}-XI3`, `${TAG}-X3`) }), undefined)).json();
    expect(matched.poNumber).toBe(`${TAG}-X3`);
    expect(matched.extraction.poOnFileFor).toBeNull();
  });
});
