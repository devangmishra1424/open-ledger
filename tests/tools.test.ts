import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getSql } from "@/db/client";
import {
  getPo, getReceipts, getVendorHistory, checkDuplicate, recallVendorCorrections, rememberCorrection, getPolicy,
} from "@/lib/agent/tools";

/**
 * Integration tests against the real, live Supabase DB — no mocks, matching this project's
 * existing standard (lib/ledger/decisions.ts's own concurrency test does the same). Seeds
 * its own fixtures under a fixed, recognizable prefix and tears them all down in afterAll,
 * in FK-safe order, so nothing pollutes the shared demo database even on a partial failure.
 */

const PREFIX = "TEST-TOOLS";
const sql = getSql();

let vendorId: string;
let po1Id: string;
let po1LineId: string;
let receiptId: string;
let currentInvoiceId: string;
let nearDupInvoiceId: string;
let correctionId: string;

beforeAll(async () => {
  vendorId = crypto.randomUUID();
  await sql`INSERT INTO vendors (id, name, trust_tier) VALUES (${vendorId}, ${PREFIX + " Vendor Co"}, 'trusted')`;

  po1Id = crypto.randomUUID();
  await sql`INSERT INTO purchase_orders (id, po_number, vendor_id, order_date) VALUES (${po1Id}, ${PREFIX + "-PO-1"}, ${vendorId}, '2026-08-01')`;

  po1LineId = crypto.randomUUID();
  await sql`
    INSERT INTO purchase_order_lines (id, po_id, line_number, description, qty_ordered, unit_price)
    VALUES (${po1LineId}, ${po1Id}, 1, 'Widget', 100, 10)`;

  receiptId = crypto.randomUUID();
  await sql`INSERT INTO goods_receipts (id, po_id, receipt_date) VALUES (${receiptId}, ${po1Id}, '2026-08-10')`;
  await sql`
    INSERT INTO goods_receipt_lines (id, goods_receipt_id, po_line_id, qty_received)
    VALUES (${crypto.randomUUID()}, ${receiptId}, ${po1LineId}, 95)`;

  currentInvoiceId = crypto.randomUUID();
  await sql`
    INSERT INTO vendor_bills (id, vendor_id, invoice_number, invoice_date, subtotal, total_amount)
    VALUES (${currentInvoiceId}, ${vendorId}, ${PREFIX + "-INV-1001"}, '2026-09-01', 1000, 1000)`;

  // near duplicate: 1-digit-off invoice number, close amount, close date
  nearDupInvoiceId = crypto.randomUUID();
  await sql`
    INSERT INTO vendor_bills (id, vendor_id, invoice_number, invoice_date, subtotal, total_amount)
    VALUES (${nearDupInvoiceId}, ${vendorId}, ${PREFIX + "-INV-1002"}, '2026-09-02', 1005, 1005)`;

  // unrelated invoice: should never show up as any kind of duplicate
  await sql`
    INSERT INTO vendor_bills (id, vendor_id, invoice_number, invoice_date, subtotal, total_amount)
    VALUES (${crypto.randomUUID()}, ${vendorId}, ${PREFIX + "-INV-9999"}, '2026-01-01', 50, 50)`;

  correctionId = crypto.randomUUID();
  await sql`
    INSERT INTO vendor_corrections (id, vendor_id, pattern, note)
    VALUES (${correctionId}, ${vendorId}, ${"non_standard_layout"}, ${"This vendor's invoices always omit a PO line reference; treat as normal."})`;
});

afterAll(async () => {
  await sql`DELETE FROM vendor_corrections WHERE vendor_id = ${vendorId}`;
  await sql`DELETE FROM vendor_bills WHERE vendor_id = ${vendorId}`;
  await sql`DELETE FROM goods_receipt_lines WHERE goods_receipt_id = ${receiptId}`;
  await sql`DELETE FROM goods_receipts WHERE po_id = ${po1Id}`;
  await sql`DELETE FROM purchase_order_lines WHERE po_id = ${po1Id}`;
  await sql`DELETE FROM purchase_orders WHERE id = ${po1Id}`;
  await sql`DELETE FROM vendors WHERE id = ${vendorId}`;
});

describe("getPo", () => {
  it("returns the PO with its lines when found", async () => {
    const r = await getPo(PREFIX + "-PO-1");
    expect(r.found).toBe(true);
    expect(r.po?.vendorId).toBe(vendorId);
    expect(r.lines).toHaveLength(1);
    expect(r.lines?.[0].unitPrice).toBe(10);
  });

  it("returns an actionable not-found message, not null, for an unknown PO number", async () => {
    const r = await getPo(PREFIX + "-PO-DOES-NOT-EXIST");
    expect(r.found).toBe(false);
    expect(r.message).toMatch(/no po found/i);
    expect(r.po).toBeUndefined();
  });
});

describe("getReceipts", () => {
  it("returns receipts with their lines for a known PO", async () => {
    const r = await getReceipts(PREFIX + "-PO-1");
    expect(r.found).toBe(true);
    expect(r.receipts).toHaveLength(1);
    expect(r.receipts?.[0].lines).toEqual([{ poLineId: po1LineId, qtyReceived: 95 }]);
  });

  it("returns an actionable not-found message for an unknown PO number", async () => {
    const r = await getReceipts(PREFIX + "-PO-DOES-NOT-EXIST");
    expect(r.found).toBe(false);
    expect(r.message).toMatch(/no po found/i);
  });
});

describe("getVendorHistory", () => {
  it("returns vendor info, recent invoices, and corrections together", async () => {
    const r = await getVendorHistory(vendorId);
    expect(r.found).toBe(true);
    expect(r.vendor?.trustTier).toBe("trusted");
    expect(r.recentInvoices?.length).toBeGreaterThanOrEqual(3); // current + near-dup + unrelated
    expect(r.corrections).toHaveLength(1);
    expect(r.corrections?.[0].pattern).toBe("non_standard_layout");
  });

  it("returns an actionable not-found message for an unknown vendor id", async () => {
    const r = await getVendorHistory(crypto.randomUUID());
    expect(r.found).toBe(false);
    expect(r.message).toMatch(/no vendor found/i);
  });
});

describe("checkDuplicate", () => {
  it("reports no exact duplicate for a normal invoice — vendor_bills' own UNIQUE(vendor_id, invoice_number) constraint makes a real exact-duplicate row physically impossible once pre-match-validation has already gated the insert; this just confirms the query itself runs clean and returns empty, not a broken/skipped check", async () => {
    const r = await checkDuplicate(currentInvoiceId);
    expect(r.found).toBe(true);
    expect(r.exactDuplicateIds).toEqual([]);
  });

  it("finds the near-duplicate (close invoice number, amount, and date) with a similarity score", async () => {
    const r = await checkDuplicate(currentInvoiceId);
    const nearIds = r.nearDuplicates?.map((d) => d.id) ?? [];
    expect(nearIds).toContain(nearDupInvoiceId);
    const match = r.nearDuplicates?.find((d) => d.id === nearDupInvoiceId);
    expect(match?.similarityScore).toBeGreaterThanOrEqual(0.5);
  });

  it("does not flag an unrelated invoice (very different amount/date/number) as any kind of duplicate", async () => {
    const r = await checkDuplicate(currentInvoiceId);
    const allFlaggedIds = [...(r.exactDuplicateIds ?? []), ...(r.nearDuplicates?.map((d) => d.id) ?? [])];
    const unrelated = await sql`SELECT id FROM vendor_bills WHERE invoice_number = ${PREFIX + "-INV-9999"}`;
    expect(allFlaggedIds).not.toContain(unrelated[0].id);
  });

  it("returns an actionable not-found message for an unknown invoice id", async () => {
    const r = await checkDuplicate(crypto.randomUUID());
    expect(r.found).toBe(false);
    expect(r.message).toMatch(/no invoice found/i);
  });
});

describe("recallVendorCorrections", () => {
  it("returns the corrections recorded for a vendor", async () => {
    const r = await recallVendorCorrections(vendorId);
    expect(r.corrections).toHaveLength(1);
    expect(r.corrections[0].id).toBe(correctionId);
  });

  it("returns an empty array for a vendor with no recorded corrections", async () => {
    const r = await recallVendorCorrections(crypto.randomUUID());
    expect(r.corrections).toEqual([]);
  });
});

describe("rememberCorrection", () => {
  it("writes a new correction that recallVendorCorrections then sees", async () => {
    const { id } = await rememberCorrection(vendorId, "test_pattern", "test note", currentInvoiceId);
    const after = await recallVendorCorrections(vendorId);
    expect(after.corrections.map((c) => c.id)).toContain(id);
    await sql`DELETE FROM vendor_corrections WHERE id = ${id}`; // clean up this test's own extra row
  });
});

describe("getPolicy", () => {
  it("returns the real dollar-threshold table and precedence rank, not a duplicate copy", () => {
    const r = getPolicy();
    expect(r.dollarThresholdTable["EXC-PRICE_VAR"]?.over50000).toBe("block");
    expect(r.precedenceRank["EXC-FRAUD_BANK"]).toBe(1);
  });
});
