import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getSql } from "@/db/client";
import { runMatchStage } from "@/lib/pipeline/match-stage";

/**
 * Integration tests against the real, live Supabase DB (no LLM calls — this stage is pure
 * Layer 1, so these are cheap and safe to run thoroughly). Seeds one vendor + several POs,
 * one per scenario, under a recognizable prefix; tears everything down in afterAll.
 */

const PREFIX = "TEST-MATCHSTAGE";
const sql = getSql();

let vendorId: string;
let trustedVendorId: string;
const poIds: string[] = [];
const billIds: string[] = [];

async function makePoWithLine(opts: { poNumber: string; status?: string; currency?: string; exchangeRate?: number; unitPrice: number; qtyOrdered: number; uom?: string }) {
  const poId = crypto.randomUUID();
  poIds.push(poId);
  await sql`
    INSERT INTO purchase_orders (id, po_number, vendor_id, order_date, status, currency, exchange_rate)
    VALUES (${poId}, ${opts.poNumber}, ${vendorId}, '2026-08-01', ${opts.status ?? "open"}, ${opts.currency ?? "USD"}, ${opts.exchangeRate ?? 1.0})`;
  const lineId = crypto.randomUUID();
  await sql`
    INSERT INTO purchase_order_lines (id, po_id, line_number, description, uom, qty_ordered, unit_price)
    VALUES (${lineId}, ${poId}, 1, 'Widget', ${opts.uom ?? "each"}, ${opts.qtyOrdered}, ${opts.unitPrice})`;
  return { poId, lineId };
}

async function acceptGoodsReceipt(poId: string, lineId: string, qtyAccepted: number, receiptDate = "2026-08-10") {
  const receiptId = crypto.randomUUID();
  await sql`INSERT INTO goods_receipts (id, po_id, receipt_date, condition) VALUES (${receiptId}, ${poId}, ${receiptDate}, 'accepted')`;
  await sql`INSERT INTO goods_receipt_lines (id, goods_receipt_id, po_line_id, qty_received) VALUES (${crypto.randomUUID()}, ${receiptId}, ${lineId}, ${qtyAccepted})`;
}

async function makeBill(opts: { poId: string | null; invoiceNumber: string; invoiceDate?: string; currency?: string; exchangeRate?: number; totalAmount: number; vendorId?: string }) {
  const billId = crypto.randomUUID();
  billIds.push(billId);
  await sql`
    INSERT INTO vendor_bills (id, vendor_id, po_id, invoice_number, invoice_date, currency, exchange_rate, subtotal, total_amount)
    VALUES (${billId}, ${opts.vendorId ?? vendorId}, ${opts.poId}, ${opts.invoiceNumber}, ${opts.invoiceDate ?? "2026-08-15"}, ${opts.currency ?? "USD"}, ${opts.exchangeRate ?? 1.0}, ${opts.totalAmount}, ${opts.totalAmount})`;
  return billId;
}

async function addBillLine(billId: string, opts: { description?: string; uom?: string; qty: number; unitPrice: number }) {
  await sql`
    INSERT INTO vendor_bill_lines (id, vendor_bill_id, description, qty_invoiced, unit_price, uom)
    VALUES (${crypto.randomUUID()}, ${billId}, ${opts.description ?? "Widget"}, ${opts.qty}, ${opts.unitPrice}, ${opts.uom ?? "each"})`;
}

beforeAll(async () => {
  vendorId = crypto.randomUUID();
  await sql`INSERT INTO vendors (id, name, trust_tier) VALUES (${vendorId}, ${PREFIX + " Vendor Co"}, 'new')`;
  trustedVendorId = crypto.randomUUID();
  await sql`INSERT INTO vendors (id, name, trust_tier) VALUES (${trustedVendorId}, ${PREFIX + " Trusted Vendor Co"}, 'trusted')`;
});

afterAll(async () => {
  for (const id of billIds) await sql`DELETE FROM vendor_bill_lines WHERE vendor_bill_id = ${id}`;
  await sql`DELETE FROM vendor_bills WHERE id = ANY(${billIds})`;
  for (const id of poIds) {
    await sql`DELETE FROM goods_receipt_lines WHERE goods_receipt_id IN (SELECT id FROM goods_receipts WHERE po_id = ${id})`;
    await sql`DELETE FROM goods_receipts WHERE po_id = ${id}`;
    await sql`DELETE FROM purchase_order_lines WHERE po_id = ${id}`;
  }
  await sql`DELETE FROM purchase_orders WHERE id = ANY(${poIds})`;
  await sql`DELETE FROM vendors WHERE id = ANY(${[vendorId, trustedVendorId]})`;
});

describe("runMatchStage", () => {
  it("a clean, fully-matched invoice auto-approves with no findings", async () => {
    const { poId, lineId } = await makePoWithLine({ poNumber: PREFIX + "-PO-CLEAN", unitPrice: 10, qtyOrdered: 100 });
    await acceptGoodsReceipt(poId, lineId, 100);
    const billId = await makeBill({ poId, invoiceNumber: PREFIX + "-INV-CLEAN", totalAmount: 1000 });
    await addBillLine(billId, { qty: 100, unitPrice: 10 });

    const r = await runMatchStage(billId);
    expect(r.findings).toEqual([]);
    expect(r.combined.overallAction).toBe("auto_approve");
  });

  it("no PO reference at all fires EXC-NON_PO using the dollar-threshold table", async () => {
    const billId = await makeBill({ poId: null, invoiceNumber: PREFIX + "-INV-NONPO", totalAmount: 500 });
    const r = await runMatchStage(billId);
    expect(r.findings).toEqual([{ code: "EXC-NON_PO", action: expect.any(String) }]);
    expect(r.combined.dominantException).toBe("EXC-NON_PO");
  });

  it("a whitelisted (trusted) vendor's small non-PO invoice auto-approves", async () => {
    const billId = await makeBill({ poId: null, invoiceNumber: PREFIX + "-INV-NONPO-TRUSTED", totalAmount: 80, vendorId: trustedVendorId });
    const r = await runMatchStage(billId);
    expect(r.combined.overallAction).toBe("auto_approve");
  });

  it("a closed PO reference fires EXC-NO_PO (data-integrity problem, not a business-as-usual non-PO purchase)", async () => {
    const { poId } = await makePoWithLine({ poNumber: PREFIX + "-PO-CLOSED", status: "closed", unitPrice: 10, qtyOrdered: 100 });
    const billId = await makeBill({ poId, invoiceNumber: PREFIX + "-INV-CLOSEDPO", totalAmount: 1000 });
    const r = await runMatchStage(billId);
    expect(r.findings).toEqual([{ code: "EXC-NO_PO", action: "escalate_l2" }]);
  });

  // Not tested: an invalid/nonexistent po_id on vendor_bills. vendor_bills.po_id is a real FK
  // to purchase_orders(id), so the DB itself refuses to let that row exist — match-stage.ts's
  // `!po` branch is defensive (matches decision-matrix's own "PO status not valid" language)
  // but isn't reachable through this schema's own constraints, same lesson as tools.test.ts's
  // exact-duplicate case.

  it("a currency mismatch between invoice and PO always fires EXC-CURRENCY block", async () => {
    const { poId, lineId } = await makePoWithLine({ poNumber: PREFIX + "-PO-CCY", unitPrice: 10, qtyOrdered: 100, currency: "USD" });
    await acceptGoodsReceipt(poId, lineId, 100);
    const billId = await makeBill({ poId, invoiceNumber: PREFIX + "-INV-CCY", totalAmount: 1000, currency: "EUR" });
    await addBillLine(billId, { qty: 100, unitPrice: 10 });
    const r = await runMatchStage(billId);
    expect(r.findings.some((f) => f.code === "EXC-CURRENCY" && f.action === "block")).toBe(true);
  });

  it("no goods receipt exists yet fires EXC-BEFORE_RCV", async () => {
    const { poId } = await makePoWithLine({ poNumber: PREFIX + "-PO-NORCV", unitPrice: 10, qtyOrdered: 100 });
    const billId = await makeBill({ poId, invoiceNumber: PREFIX + "-INV-NORCV", totalAmount: 1000 });
    await addBillLine(billId, { qty: 100, unitPrice: 10 });
    const r = await runMatchStage(billId);
    expect(r.findings.some((f) => f.code === "EXC-BEFORE_RCV")).toBe(true);
  });

  it("a receipt that exists with only a short gap does NOT fire EXC-BEFORE_RCV", async () => {
    const { poId, lineId } = await makePoWithLine({ poNumber: PREFIX + "-PO-SHORTGAP", unitPrice: 10, qtyOrdered: 100 });
    await acceptGoodsReceipt(poId, lineId, 100, "2026-08-14"); // 1 day before the 08-15 invoice date
    const billId = await makeBill({ poId, invoiceNumber: PREFIX + "-INV-SHORTGAP", invoiceDate: "2026-08-15", totalAmount: 1000 });
    await addBillLine(billId, { qty: 100, unitPrice: 10 });
    const r = await runMatchStage(billId);
    expect(r.findings.some((f) => f.code === "EXC-BEFORE_RCV")).toBe(false);
  });

  it("a price variance beyond tolerance fires EXC-PRICE_VAR", async () => {
    const { poId, lineId } = await makePoWithLine({ poNumber: PREFIX + "-PO-PRICEVAR", unitPrice: 10, qtyOrdered: 100 });
    await acceptGoodsReceipt(poId, lineId, 100);
    const billId = await makeBill({ poId, invoiceNumber: PREFIX + "-INV-PRICEVAR", totalAmount: 1100 });
    await addBillLine(billId, { qty: 100, unitPrice: 11 }); // 10% over PO's $10 unit price
    const r = await runMatchStage(billId);
    expect(r.findings.some((f) => f.code === "EXC-PRICE_VAR")).toBe(true);
  });

  it("invoicing more than the GRN's accepted quantity fires EXC-QTY_VAR, even though it matches the PO's ordered quantity", async () => {
    const { poId, lineId } = await makePoWithLine({ poNumber: PREFIX + "-PO-QTYVAR", unitPrice: 10, qtyOrdered: 100 });
    await acceptGoodsReceipt(poId, lineId, 80); // only 80 accepted, 20 damaged/rejected
    const billId = await makeBill({ poId, invoiceNumber: PREFIX + "-INV-QTYVAR", totalAmount: 1000 });
    await addBillLine(billId, { qty: 100, unitPrice: 10 }); // bills for the full PO qty, not just what was accepted
    const r = await runMatchStage(billId);
    expect(r.findings.some((f) => f.code === "EXC-QTY_VAR")).toBe(true);
  });

  it("damaged/rejected receipts don't count toward accepted quantity", async () => {
    const { poId, lineId } = await makePoWithLine({ poNumber: PREFIX + "-PO-DAMAGED", unitPrice: 10, qtyOrdered: 100 });
    const receiptId = crypto.randomUUID();
    await sql`INSERT INTO goods_receipts (id, po_id, receipt_date, condition) VALUES (${receiptId}, ${poId}, '2026-08-10', 'damaged')`;
    await sql`INSERT INTO goods_receipt_lines (id, goods_receipt_id, po_line_id, qty_received) VALUES (${crypto.randomUUID()}, ${receiptId}, ${lineId}, 100)`;
    const billId = await makeBill({ poId, invoiceNumber: PREFIX + "-INV-DAMAGED", totalAmount: 1000 });
    await addBillLine(billId, { qty: 100, unitPrice: 10 });
    const r = await runMatchStage(billId);
    expect(r.findings.some((f) => f.code === "EXC-QTY_VAR")).toBe(true); // 0 actually accepted
  });

  it("split invoice (spec §1.6 Scenario B): a second partial invoice against the same PO line closes it cleanly, no false exception", async () => {
    const { poId, lineId } = await makePoWithLine({ poNumber: PREFIX + "-PO-SPLIT", unitPrice: 10, qtyOrdered: 100 });
    await acceptGoodsReceipt(poId, lineId, 100);

    const bill1 = await makeBill({ poId, invoiceNumber: PREFIX + "-INV-SPLIT-1", totalAmount: 600 });
    await addBillLine(bill1, { qty: 60, unitPrice: 10 });
    const r1 = await runMatchStage(bill1);
    expect(r1.findings.some((f) => f.code === "EXC-QTY_VAR")).toBe(false);
    // simulate the first invoice having already been approved, so the second sees it as a real prior claim
    await sql`UPDATE vendor_bills SET status = 'approved' WHERE id = ${bill1}`;

    const bill2 = await makeBill({ poId, invoiceNumber: PREFIX + "-INV-SPLIT-2", totalAmount: 400 });
    await addBillLine(bill2, { qty: 40, unitPrice: 10 });
    const r2 = await runMatchStage(bill2);
    expect(r2.findings.some((f) => f.code === "EXC-QTY_VAR")).toBe(false); // 60 + 40 = 100, closes exactly
  });

  it("split invoice over-claim: a second invoice billing for more than what's left after a prior invoice fires EXC-QTY_VAR for just the excess", async () => {
    const { poId, lineId } = await makePoWithLine({ poNumber: PREFIX + "-PO-SPLIT-OVER", unitPrice: 10, qtyOrdered: 100 });
    await acceptGoodsReceipt(poId, lineId, 100);

    const bill1 = await makeBill({ poId, invoiceNumber: PREFIX + "-INV-SPLITOVER-1", totalAmount: 600 });
    await addBillLine(bill1, { qty: 60, unitPrice: 10 });
    await runMatchStage(bill1);
    await sql`UPDATE vendor_bills SET status = 'approved' WHERE id = ${bill1}`;

    // only 40 units remain available (100 received - 60 already claimed), but this bills for 50
    const bill2 = await makeBill({ poId, invoiceNumber: PREFIX + "-INV-SPLITOVER-2", totalAmount: 500 });
    await addBillLine(bill2, { qty: 50, unitPrice: 10 });
    const r2 = await runMatchStage(bill2);
    expect(r2.findings.some((f) => f.code === "EXC-QTY_VAR")).toBe(true);
  });
});
