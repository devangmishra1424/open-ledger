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
let taxCodeId: string;
const poIds: string[] = [];
const billIds: string[] = [];

async function makePoWithLine(opts: { poNumber: string; status?: string; currency?: string; exchangeRate?: number; unitPrice: number; qtyOrdered: number; uom?: string; poType?: string; maxValueCeiling?: number; maxQtyCeiling?: number }) {
  const poId = crypto.randomUUID();
  poIds.push(poId);
  await sql`
    INSERT INTO purchase_orders (id, po_number, vendor_id, order_date, status, currency, exchange_rate, po_type, max_value_ceiling, max_qty_ceiling)
    VALUES (${poId}, ${opts.poNumber}, ${vendorId}, '2026-08-01', ${opts.status ?? "open"}, ${opts.currency ?? "USD"}, ${opts.exchangeRate ?? 1.0}, ${opts.poType ?? "standard"}, ${opts.maxValueCeiling ?? null}, ${opts.maxQtyCeiling ?? null})`;
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

async function makeBill(opts: { poId: string | null; invoiceNumber: string; invoiceDate?: string; currency?: string; exchangeRate?: number; totalAmount: number; vendorId?: string; invoiceType?: string; relatedInvoiceId?: string }) {
  const billId = crypto.randomUUID();
  billIds.push(billId);
  await sql`
    INSERT INTO vendor_bills (id, vendor_id, po_id, invoice_number, invoice_date, currency, exchange_rate, subtotal, total_amount, invoice_type, related_invoice_id)
    VALUES (${billId}, ${opts.vendorId ?? vendorId}, ${opts.poId}, ${opts.invoiceNumber}, ${opts.invoiceDate ?? "2026-08-15"}, ${opts.currency ?? "USD"}, ${opts.exchangeRate ?? 1.0}, ${opts.totalAmount}, ${opts.totalAmount}, ${opts.invoiceType ?? "standard"}, ${opts.relatedInvoiceId ?? null})`;
  return billId;
}

async function addBillLine(billId: string, opts: { description?: string; uom?: string; qty: number; unitPrice: number; taxAmount?: number; taxCodeId?: string }) {
  await sql`
    INSERT INTO vendor_bill_lines (id, vendor_bill_id, description, qty_invoiced, unit_price, uom, tax_amount, tax_code_id)
    VALUES (${crypto.randomUUID()}, ${billId}, ${opts.description ?? "Widget"}, ${opts.qty}, ${opts.unitPrice}, ${opts.uom ?? "each"}, ${opts.taxAmount ?? null}, ${opts.taxCodeId ?? null})`;
}

beforeAll(async () => {
  vendorId = crypto.randomUUID();
  await sql`INSERT INTO vendors (id, name, trust_tier) VALUES (${vendorId}, ${PREFIX + " Vendor Co"}, 'new')`;
  trustedVendorId = crypto.randomUUID();
  await sql`INSERT INTO vendors (id, name, trust_tier) VALUES (${trustedVendorId}, ${PREFIX + " Trusted Vendor Co"}, 'trusted')`;
  taxCodeId = crypto.randomUUID();
  await sql`
    INSERT INTO tax_codes (id, name, rate, tax_type, direction, effective_from)
    VALUES (${taxCodeId}, ${PREFIX + " Sales Tax"}, 0.0825, 'sales_tax', 'input', '2026-01-01')`;
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
  await sql`DELETE FROM tax_codes WHERE id = ${taxCodeId}`;
  await sql`DELETE FROM vendor_corrections WHERE vendor_id = ANY(${[vendorId, trustedVendorId]})`;
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

  describe("EXC-BLANKET_EXCEEDED (ALGORITHMS.md §7, PO-header-level cumulative ceiling)", () => {
    it("matches the spec's own worked example: $48,500 prior + $3,000 = $51,500 against a $50,000 ceiling (3% over) escalates L2", async () => {
      const { poId, lineId } = await makePoWithLine({ poNumber: PREFIX + "-PO-BLANKET-1", unitPrice: 1, qtyOrdered: 100000, poType: "blanket", maxValueCeiling: 50000 });
      await acceptGoodsReceipt(poId, lineId, 100000);

      const priorBill = await makeBill({ poId, invoiceNumber: PREFIX + "-BLANKET-PRIOR", totalAmount: 48500 });
      await addBillLine(priorBill, { qty: 48500, unitPrice: 1 });
      await runMatchStage(priorBill);
      await sql`UPDATE vendor_bills SET status = 'approved' WHERE id = ${priorBill}`;

      const currentBill = await makeBill({ poId, invoiceNumber: PREFIX + "-BLANKET-CURRENT", totalAmount: 3000 });
      await addBillLine(currentBill, { qty: 3000, unitPrice: 1 });
      const r = await runMatchStage(currentBill);
      expect(r.findings.find((f) => f.code === "EXC-BLANKET_EXCEEDED")?.action).toBe("escalate_l2");
    });

    it("an overage beyond 10% of the ceiling blocks instead of escalating", async () => {
      const { poId, lineId } = await makePoWithLine({ poNumber: PREFIX + "-PO-BLANKET-2", unitPrice: 1, qtyOrdered: 100000, poType: "blanket", maxValueCeiling: 10000 });
      await acceptGoodsReceipt(poId, lineId, 100000);

      const bill = await makeBill({ poId, invoiceNumber: PREFIX + "-BLANKET-OVER", totalAmount: 12000 }); // 20% over
      await addBillLine(bill, { qty: 12000, unitPrice: 1 });
      const r = await runMatchStage(bill);
      expect(r.findings.find((f) => f.code === "EXC-BLANKET_EXCEEDED")?.action).toBe("block");
    });

    it("staying within the ceiling raises no exception at all", async () => {
      const { poId, lineId } = await makePoWithLine({ poNumber: PREFIX + "-PO-BLANKET-3", unitPrice: 1, qtyOrdered: 100000, poType: "blanket", maxValueCeiling: 50000 });
      await acceptGoodsReceipt(poId, lineId, 100000);

      const bill = await makeBill({ poId, invoiceNumber: PREFIX + "-BLANKET-WITHIN", totalAmount: 40000 });
      await addBillLine(bill, { qty: 40000, unitPrice: 1 });
      const r = await runMatchStage(bill);
      expect(r.findings.some((f) => f.code === "EXC-BLANKET_EXCEEDED")).toBe(false);
    });

    it("a standard (non-blanket) PO's max_value_ceiling, if ever set, is ignored — the check only applies to po_type='blanket'", async () => {
      const { poId, lineId } = await makePoWithLine({ poNumber: PREFIX + "-PO-BLANKET-4", unitPrice: 1, qtyOrdered: 100000, poType: "standard", maxValueCeiling: 100 });
      await acceptGoodsReceipt(poId, lineId, 100000);

      const bill = await makeBill({ poId, invoiceNumber: PREFIX + "-BLANKET-STANDARD", totalAmount: 5000 });
      await addBillLine(bill, { qty: 5000, unitPrice: 1 });
      const r = await runMatchStage(bill);
      expect(r.findings.some((f) => f.code === "EXC-BLANKET_EXCEEDED")).toBe(false);
    });

    it("the quantity ceiling is checked independently of the value ceiling", async () => {
      const { poId, lineId } = await makePoWithLine({ poNumber: PREFIX + "-PO-BLANKET-5", unitPrice: 1, qtyOrdered: 100000, poType: "blanket", maxQtyCeiling: 1000 });
      await acceptGoodsReceipt(poId, lineId, 100000);

      const bill = await makeBill({ poId, invoiceNumber: PREFIX + "-BLANKET-QTY", totalAmount: 1100 });
      await addBillLine(bill, { qty: 1100, unitPrice: 1 }); // 10% over the 1000-unit ceiling
      const r = await runMatchStage(bill);
      expect(r.findings.find((f) => f.code === "EXC-BLANKET_EXCEEDED")?.action).toBe("escalate_l2");
    });
  });

  describe("EXC-TAX_VAR (spec §2 EXC-10)", () => {
    it("matches the spec's own worked example: 8.25% expected vs 10.00% actual = 1.75pp escalates L1", async () => {
      const { poId, lineId } = await makePoWithLine({ poNumber: PREFIX + "-PO-TAX-1", unitPrice: 10, qtyOrdered: 50 });
      await acceptGoodsReceipt(poId, lineId, 50);
      const billId = await makeBill({ poId, invoiceNumber: PREFIX + "-TAX-1", totalAmount: 500 });
      // lineAmount = 50*10 = 500; actual tax charged = 50 (10.00%) vs expected 8.25% (41.25)
      await addBillLine(billId, { qty: 50, unitPrice: 10, taxAmount: 50, taxCodeId });
      const r = await runMatchStage(billId);
      expect(r.findings.find((f) => f.code === "EXC-TAX_VAR")?.action).toBe("escalate_l1");
    });

    it("a tax rate within tolerance raises no exception", async () => {
      const { poId, lineId } = await makePoWithLine({ poNumber: PREFIX + "-PO-TAX-2", unitPrice: 10, qtyOrdered: 50 });
      await acceptGoodsReceipt(poId, lineId, 50);
      const billId = await makeBill({ poId, invoiceNumber: PREFIX + "-TAX-2", totalAmount: 500 });
      // exactly the expected 8.25% rate
      await addBillLine(billId, { qty: 50, unitPrice: 10, taxAmount: 41.25, taxCodeId });
      const r = await runMatchStage(billId);
      expect(r.findings.some((f) => f.code === "EXC-TAX_VAR")).toBe(false);
    });

    it("a line with no tax_amount set raises no exception — nothing to compare", async () => {
      const { poId, lineId } = await makePoWithLine({ poNumber: PREFIX + "-PO-TAX-3", unitPrice: 10, qtyOrdered: 50 });
      await acceptGoodsReceipt(poId, lineId, 50);
      const billId = await makeBill({ poId, invoiceNumber: PREFIX + "-TAX-3", totalAmount: 500 });
      await addBillLine(billId, { qty: 50, unitPrice: 10 });
      const r = await runMatchStage(billId);
      expect(r.findings.some((f) => f.code === "EXC-TAX_VAR")).toBe(false);
    });

    it("a large rate diff (>2pp) blocks", async () => {
      const { poId, lineId } = await makePoWithLine({ poNumber: PREFIX + "-PO-TAX-4", unitPrice: 10, qtyOrdered: 50 });
      await acceptGoodsReceipt(poId, lineId, 50);
      const billId = await makeBill({ poId, invoiceNumber: PREFIX + "-TAX-4", totalAmount: 500 });
      await addBillLine(billId, { qty: 50, unitPrice: 10, taxAmount: 70, taxCodeId }); // 14% actual vs 8.25% expected
      const r = await runMatchStage(billId);
      expect(r.findings.find((f) => f.code === "EXC-TAX_VAR")?.action).toBe("block");
    });
  });

  describe("EXC-CREDIT_MEMO (spec §2 EXC-07)", () => {
    it("matches the spec's own worked example: a credit against an already-paid invoice nets negative, escalates L1", async () => {
      const originalId = await makeBill({ poId: null, invoiceNumber: PREFIX + "-CM-ORIGINAL-1", totalAmount: 10000 });
      await sql`UPDATE vendor_bills SET status = 'paid' WHERE id = ${originalId}`;

      const creditId = await makeBill({ poId: null, invoiceNumber: PREFIX + "-CM-1", totalAmount: 1500, invoiceType: "credit_memo", relatedInvoiceId: originalId });
      const r = await runMatchStage(creditId);
      expect(r.findings).toEqual([{ code: "EXC-CREDIT_MEMO", action: "escalate_l1" }]);
      expect(r.detail.creditMemoNetAmount).toBe(-1500);
    });

    it("auto-approves when the related invoice is still open and the credit doesn't exceed it (net >= 0)", async () => {
      const originalId = await makeBill({ poId: null, invoiceNumber: PREFIX + "-CM-ORIGINAL-2", totalAmount: 10000 });
      // status stays 'processing' — still "open" for this simplified netting check

      const creditId = await makeBill({ poId: null, invoiceNumber: PREFIX + "-CM-2", totalAmount: 1500, invoiceType: "credit_memo", relatedInvoiceId: originalId });
      const r = await runMatchStage(creditId);
      expect(r.findings).toEqual([{ code: "EXC-CREDIT_MEMO", action: "auto_approve" }]);
      expect(r.detail.creditMemoNetAmount).toBe(8500);
    });

    it("skips the check (no fabricated finding) when related_invoice_id isn't set", async () => {
      const creditId = await makeBill({ poId: null, invoiceNumber: PREFIX + "-CM-3", totalAmount: 1500, invoiceType: "credit_memo" });
      const r = await runMatchStage(creditId);
      expect(r.findings).toEqual([]);
      expect(r.detail.creditMemoNote).toMatch(/no related_invoice_id/);
    });

    it("a credit memo never goes through normal PO 3-way matching, even if a po_id happens to be set", async () => {
      const { poId, lineId } = await makePoWithLine({ poNumber: PREFIX + "-PO-CM-4", unitPrice: 10, qtyOrdered: 50 });
      await acceptGoodsReceipt(poId, lineId, 50);
      const originalId = await makeBill({ poId: null, invoiceNumber: PREFIX + "-CM-ORIGINAL-4", totalAmount: 500 });
      await sql`UPDATE vendor_bills SET status = 'paid' WHERE id = ${originalId}`;

      const creditId = await makeBill({ poId, invoiceNumber: PREFIX + "-CM-4", totalAmount: 500, invoiceType: "credit_memo", relatedInvoiceId: originalId });
      await addBillLine(creditId, { qty: 999, unitPrice: 10 }); // would be a wild EXC-QTY_VAR if 3-way matching ran
      const r = await runMatchStage(creditId);
      expect(r.findings).toEqual([{ code: "EXC-CREDIT_MEMO", action: "escalate_l1" }]);
    });
  });

  describe("EXC-UOM_MISMATCH (ALGORITHMS.md §14)", () => {
    it("matches the spec's own worked example: no conversion on file, but case<->each is plausible, escalates L1", async () => {
      const { poId, lineId } = await makePoWithLine({ poNumber: PREFIX + "-PO-UOM-1", unitPrice: 2, qtyOrdered: 10, uom: "case" });
      await acceptGoodsReceipt(poId, lineId, 10);
      const billId = await makeBill({ poId, invoiceNumber: PREFIX + "-UOM-1", totalAmount: 480 });
      await addBillLine(billId, { qty: 240, unitPrice: 2, uom: "each" });
      const r = await runMatchStage(billId);
      expect(r.findings.find((f) => f.code === "EXC-UOM_MISMATCH")?.action).toBe("escalate_l1");
    });

    it("fundamentally incompatible units (hours vs each) block instead of escalating", async () => {
      const { poId, lineId } = await makePoWithLine({ poNumber: PREFIX + "-PO-UOM-2", unitPrice: 2, qtyOrdered: 10, uom: "hours" });
      await acceptGoodsReceipt(poId, lineId, 10);
      const billId = await makeBill({ poId, invoiceNumber: PREFIX + "-UOM-2", totalAmount: 20 });
      await addBillLine(billId, { qty: 10, unitPrice: 2, uom: "each" });
      const r = await runMatchStage(billId);
      expect(r.findings.find((f) => f.code === "EXC-UOM_MISMATCH")?.action).toBe("block");
    });

    it("a confirmed conversion factor on file resolves the mismatch — no exception raised", async () => {
      await sql`
        INSERT INTO vendor_corrections (id, vendor_id, pattern, note, uom_from, uom_to, conversion_factor)
        VALUES (${crypto.randomUUID()}, ${vendorId}, 'uom_conversion', '1 case = 24 each, confirmed by AP clerk', 'case', 'each', 24)`;
      const { poId, lineId } = await makePoWithLine({ poNumber: PREFIX + "-PO-UOM-3", unitPrice: 2, qtyOrdered: 10, uom: "case" });
      await acceptGoodsReceipt(poId, lineId, 10);
      const billId = await makeBill({ poId, invoiceNumber: PREFIX + "-UOM-3", totalAmount: 480 });
      await addBillLine(billId, { qty: 240, unitPrice: 2, uom: "each" });
      const r = await runMatchStage(billId);
      expect(r.findings.some((f) => f.code === "EXC-UOM_MISMATCH")).toBe(false);
    });

    it("matching units raise no exception at all", async () => {
      const { poId, lineId } = await makePoWithLine({ poNumber: PREFIX + "-PO-UOM-4", unitPrice: 2, qtyOrdered: 10, uom: "each" });
      await acceptGoodsReceipt(poId, lineId, 10);
      const billId = await makeBill({ poId, invoiceNumber: PREFIX + "-UOM-4", totalAmount: 20 });
      await addBillLine(billId, { qty: 10, unitPrice: 2, uom: "each" });
      const r = await runMatchStage(billId);
      expect(r.findings.some((f) => f.code === "EXC-UOM_MISMATCH")).toBe(false);
    });
  });
});
