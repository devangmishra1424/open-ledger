import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getSql } from "@/db/client";
import {
  computeIdempotencyKey, assertBalanced, buildBillApprovalDraft, buildPaymentDraft,
  postBillApproval, postPayment, type JournalLineDraft,
} from "@/lib/ledger/journal";

/**
 * Part 1: pure builder/balance logic — no DB required, always runs. Part 2 (below) is a live
 * integration suite against the real Supabase DB, following tests/match-stage.test.ts's own
 * prefix-and-cleanup convention, since DATABASE_URL is available in this environment.
 */

describe("computeIdempotencyKey", () => {
  it("is deterministic for the same inputs", () => {
    const a = computeIdempotencyKey("vendor_bill", "bill-1", "bill_approval");
    const b = computeIdempotencyKey("vendor_bill", "bill-1", "bill_approval");
    expect(a).toBe(b);
  });

  it("differs when any input differs", () => {
    const base = computeIdempotencyKey("vendor_bill", "bill-1", "bill_approval");
    expect(computeIdempotencyKey("vendor_bill", "bill-2", "bill_approval")).not.toBe(base);
    expect(computeIdempotencyKey("payment", "bill-1", "bill_approval")).not.toBe(base);
    expect(computeIdempotencyKey("vendor_bill", "bill-1", "payment_posting")).not.toBe(base);
  });
});

describe("assertBalanced", () => {
  it("passes when debits equal credits", () => {
    const lines: JournalLineDraft[] = [
      { accountId: "6000", debitAmount: 100, creditAmount: 0, currencyAmount: 100, baseCurrencyAmount: 100 },
      { accountId: "2000", debitAmount: 0, creditAmount: 100, currencyAmount: 100, baseCurrencyAmount: 100 },
    ];
    expect(() => assertBalanced(lines)).not.toThrow();
  });

  it("throws when debits and credits diverge beyond the rounding epsilon", () => {
    const lines: JournalLineDraft[] = [
      { accountId: "6000", debitAmount: 100, creditAmount: 0, currencyAmount: 100, baseCurrencyAmount: 100 },
      { accountId: "2000", debitAmount: 0, creditAmount: 99, currencyAmount: 99, baseCurrencyAmount: 99 },
    ];
    expect(() => assertBalanced(lines)).toThrow(/not balanced/);
  });

  it("tolerates sub-cent float noise", () => {
    const lines: JournalLineDraft[] = [
      { accountId: "6000", debitAmount: 100.001, creditAmount: 0, currencyAmount: 100.001, baseCurrencyAmount: 100.001 },
      { accountId: "2000", debitAmount: 0, creditAmount: 100, currencyAmount: 100, baseCurrencyAmount: 100 },
    ];
    expect(() => assertBalanced(lines)).not.toThrow();
  });
});

describe("buildBillApprovalDraft", () => {
  it("builds a balanced Dr Expense / Cr AP entry with no tax", () => {
    const draft = buildBillApprovalDraft({
      billId: "bill-1", invoiceNumber: "INV-1", currency: "USD", exchangeRate: 1.0,
      totalAmount: 1000, taxTotal: 0, apAccountId: "2000", taxAccountId: null,
      lines: [{ accountId: "6000", amount: 1000 }], entryDate: "2026-09-01",
    });
    expect(draft.lines).toEqual([
      { accountId: "6000", debitAmount: 1000, creditAmount: 0, currencyAmount: 1000, baseCurrencyAmount: 1000 },
      { accountId: "2000", debitAmount: 0, creditAmount: 1000, currencyAmount: 1000, baseCurrencyAmount: 1000 },
    ]);
    expect(draft.sourceType).toBe("vendor_bill");
    expect(draft.idempotencyKey).toBe(computeIdempotencyKey("vendor_bill", "bill-1", "bill_approval"));
  });

  it("adds a tax debit line so the entry still balances against total_amount (subtotal+tax)", () => {
    const draft = buildBillApprovalDraft({
      billId: "bill-2", invoiceNumber: "INV-2", currency: "USD", exchangeRate: 1.0,
      totalAmount: 1080, taxTotal: 80, apAccountId: "2000", taxAccountId: "2210",
      lines: [{ accountId: "6000", amount: 1000 }], entryDate: "2026-09-01",
    });
    const debitSum = draft.lines.reduce((s, l) => s + l.debitAmount, 0);
    const creditSum = draft.lines.reduce((s, l) => s + l.creditAmount, 0);
    expect(debitSum).toBe(1080);
    expect(creditSum).toBe(1080);
    expect(draft.lines.find((l) => l.accountId === "2210")?.debitAmount).toBe(80);
  });

  it("converts to base currency using the bill's exchange rate", () => {
    const draft = buildBillApprovalDraft({
      billId: "bill-3", invoiceNumber: "INV-3", currency: "EUR", exchangeRate: 1.1,
      totalAmount: 1000, taxTotal: 0, apAccountId: "2000", taxAccountId: null,
      lines: [{ accountId: "6000", amount: 1000 }], entryDate: "2026-09-01",
    });
    expect(draft.lines[0].baseCurrencyAmount).toBeCloseTo(1100, 6);
    expect(draft.lines[1].baseCurrencyAmount).toBeCloseTo(1100, 6);
  });

  it("throws if tax_total > 0 but no tax account was resolved (data gap, not silently dropped)", () => {
    expect(() =>
      buildBillApprovalDraft({
        billId: "bill-4", invoiceNumber: "INV-4", currency: "USD", exchangeRate: 1.0,
        totalAmount: 1080, taxTotal: 80, apAccountId: "2000", taxAccountId: null,
        lines: [{ accountId: "6000", amount: 1000 }], entryDate: "2026-09-01",
      })
    ).toThrow(/tax account/);
  });

  it("throws (via assertBalanced) when bill line amounts don't actually sum to total_amount", () => {
    expect(() =>
      buildBillApprovalDraft({
        billId: "bill-5", invoiceNumber: "INV-5", currency: "USD", exchangeRate: 1.0,
        totalAmount: 1000, taxTotal: 0, apAccountId: "2000", taxAccountId: null,
        lines: [{ accountId: "6000", amount: 900 }], entryDate: "2026-09-01", // real data inconsistency
      })
    ).toThrow(/not balanced/);
  });
});

describe("buildPaymentDraft", () => {
  it("builds one AP debit line per application plus one Cash credit line for the total", () => {
    const draft = buildPaymentDraft({
      paymentId: "pay-1", totalAmount: 1000, currency: "USD", exchangeRate: 1.0, cashAccountId: "1000",
      applications: [
        { vendorBillId: "bill-a", appliedAmount: 600, apAccountId: "2000", vendorId: "vendor-a" },
        { vendorBillId: "bill-b", appliedAmount: 400, apAccountId: "2000", vendorId: "vendor-b" },
      ],
      entryDate: "2026-09-01",
    });
    expect(draft.lines).toHaveLength(3);
    expect(draft.lines.filter((l) => l.debitAmount > 0).map((l) => l.debitAmount).sort()).toEqual([400, 600]);
    expect(draft.lines.find((l) => l.accountId === "1000")?.creditAmount).toBe(1000);
  });

  it("throws when applications don't sum to the payment total (split payment must fully cover it)", () => {
    expect(() =>
      buildPaymentDraft({
        paymentId: "pay-2", totalAmount: 1000, currency: "USD", exchangeRate: 1.0, cashAccountId: "1000",
        applications: [{ vendorBillId: "bill-a", appliedAmount: 600, apAccountId: "2000", vendorId: "vendor-a" }],
        entryDate: "2026-09-01",
      })
    ).toThrow(/not balanced/);
  });

  it("throws when applications is empty", () => {
    expect(() =>
      buildPaymentDraft({
        paymentId: "pay-3", totalAmount: 1000, currency: "USD", exchangeRate: 1.0, cashAccountId: "1000",
        applications: [], entryDate: "2026-09-01",
      })
    ).toThrow(/no applications/);
  });
});

// ---------------------------------------------------------------------------------------
// Part 2: live integration tests against the real Supabase DB (same convention as
// tests/match-stage.test.ts — a recognizable prefix, full teardown in afterAll).
// ---------------------------------------------------------------------------------------

const PREFIX = "TEST-JOURNAL";
const sql = getSql();

let vendorId: string;
let taxCodeId: string;
const billIds: string[] = [];
const paymentIds: string[] = [];
const journalEntryIds: string[] = [];
const poIds: string[] = [];

async function makeBill(opts: { invoiceNumber: string; subtotal: number; taxTotal?: number; apAccountId?: string | null }) {
  const billId = crypto.randomUUID();
  billIds.push(billId);
  const taxTotal = opts.taxTotal ?? 0;
  await sql`
    INSERT INTO vendor_bills (id, vendor_id, po_id, invoice_number, invoice_date, currency, exchange_rate,
      subtotal, tax_total, total_amount, ap_account_id, status)
    VALUES (${billId}, ${vendorId}, NULL, ${opts.invoiceNumber}, '2026-09-01', 'USD', 1.0,
      ${opts.subtotal}, ${taxTotal}, ${opts.subtotal + taxTotal}, ${opts.apAccountId ?? null}, 'matched')
  `;
  return billId;
}

async function addBillLine(billId: string, opts: { qty: number; unitPrice: number; glAccountId?: string | null; taxCode?: boolean }) {
  await sql`
    INSERT INTO vendor_bill_lines (id, vendor_bill_id, description, qty_invoiced, unit_price, uom, gl_account_id, tax_code_id)
    VALUES (${crypto.randomUUID()}, ${billId}, 'Widget', ${opts.qty}, ${opts.unitPrice}, 'each',
      ${opts.glAccountId ?? null}, ${opts.taxCode ? taxCodeId : null})
  `;
}

async function makePayment(opts: { totalAmount: number; paymentDate?: string }) {
  const paymentId = crypto.randomUUID();
  paymentIds.push(paymentId);
  await sql`
    INSERT INTO payments (id, method, payment_date, total_amount)
    VALUES (${paymentId}, 'ach', ${opts.paymentDate ?? "2026-09-05"}, ${opts.totalAmount})
  `;
  return paymentId;
}

beforeAll(async () => {
  vendorId = crypto.randomUUID();
  await sql`INSERT INTO vendors (id, name, trust_tier) VALUES (${vendorId}, ${PREFIX + " Vendor Co"}, 'new')`;
  taxCodeId = crypto.randomUUID();
  await sql`
    INSERT INTO tax_codes (id, name, rate, tax_type, direction, tax_account_id, effective_from)
    VALUES (${taxCodeId}, ${PREFIX + " Sales Tax"}, 0.08, 'sales_tax', 'input', '2210', '2026-01-01')
  `;
});

afterAll(async () => {
  await sql`DELETE FROM journal_entry_lines WHERE entry_id = ANY(${journalEntryIds})`;
  await sql`DELETE FROM payment_applications WHERE payment_id = ANY(${paymentIds})`;
  await sql`UPDATE payments SET journal_entry_id = NULL WHERE id = ANY(${paymentIds})`;
  await sql`UPDATE vendor_bills SET journal_entry_id = NULL WHERE id = ANY(${billIds})`;
  await sql`DELETE FROM journal_entries WHERE id = ANY(${journalEntryIds})`;
  await sql`DELETE FROM payments WHERE id = ANY(${paymentIds})`;
  await sql`DELETE FROM vendor_bill_lines WHERE vendor_bill_id = ANY(${billIds})`;
  await sql`DELETE FROM vendor_bills WHERE id = ANY(${billIds})`;
  await sql`DELETE FROM purchase_order_lines WHERE po_id = ANY(${poIds})`;
  await sql`DELETE FROM purchase_orders WHERE id = ANY(${poIds})`;
  await sql`DELETE FROM tax_codes WHERE id = ${taxCodeId}`;
  await sql`DELETE FROM vendors WHERE id = ${vendorId}`;
});

describe("postBillApproval (live DB)", () => {
  it("posts a balanced Dr Expense / Cr AP entry and marks the bill posted", async () => {
    const billId = await makeBill({ invoiceNumber: PREFIX + "-INV-CLEAN", subtotal: 1000 });
    await addBillLine(billId, { qty: 100, unitPrice: 10, glAccountId: "6000" });

    const result = await postBillApproval(billId);
    journalEntryIds.push(result.journalEntryId);
    expect(result.alreadyPosted).toBe(false);

    const entryRows = await sql`SELECT * FROM journal_entries WHERE id = ${result.journalEntryId}`;
    expect(entryRows[0].status).toBe("posted");
    expect(entryRows[0].source_type).toBe("vendor_bill");
    expect(entryRows[0].source_id).toBe(billId);

    const lineRows = await sql`SELECT * FROM journal_entry_lines WHERE entry_id = ${result.journalEntryId}`;
    const debitSum = lineRows.reduce((s: number, l: any) => s + Number(l.debit_amount), 0);
    const creditSum = lineRows.reduce((s: number, l: any) => s + Number(l.credit_amount), 0);
    expect(debitSum).toBe(1000);
    expect(creditSum).toBe(1000);

    const billRows = await sql`SELECT * FROM vendor_bills WHERE id = ${billId}`;
    expect(billRows[0].status).toBe("posted");
    expect(billRows[0].journal_entry_id).toBe(result.journalEntryId);
  });

  it("falls back to the PO line's gl_account_id when the bill line has none — verified via a real PO fixture", async () => {
    // Build a minimal PO + line so the fallback path is exercised against a real FK, not a mock.
    const poId = crypto.randomUUID();
    poIds.push(poId);
    await sql`INSERT INTO purchase_orders (id, po_number, vendor_id, order_date, status) VALUES (${poId}, ${PREFIX + "-PO-FALLBACK"}, ${vendorId}, '2026-08-01', 'open')`;
    const poLineId = crypto.randomUUID();
    await sql`INSERT INTO purchase_order_lines (id, po_id, line_number, description, uom, qty_ordered, unit_price, gl_account_id) VALUES (${poLineId}, ${poId}, 1, 'Widget', 'each', 100, 10, '6100')`;

    const billId = crypto.randomUUID();
    billIds.push(billId);
    await sql`
      INSERT INTO vendor_bills (id, vendor_id, po_id, invoice_number, invoice_date, currency, exchange_rate, subtotal, tax_total, total_amount, status)
      VALUES (${billId}, ${vendorId}, ${poId}, ${PREFIX + "-INV-POFALLBACK"}, '2026-09-01', 'USD', 1.0, 1000, 0, 1000, 'matched')
    `;
    await sql`
      INSERT INTO vendor_bill_lines (id, vendor_bill_id, po_line_id, description, qty_invoiced, unit_price, uom)
      VALUES (${crypto.randomUUID()}, ${billId}, ${poLineId}, 'Widget', 100, 10, 'each')
    `;

    const result = await postBillApproval(billId);
    journalEntryIds.push(result.journalEntryId);
    const lineRows = await sql`SELECT * FROM journal_entry_lines WHERE entry_id = ${result.journalEntryId} AND debit_amount > 0`;
    expect(lineRows[0].account_id).toBe("6100");
  });

  it("includes a tax debit line when the bill has tax_total, still balancing to total_amount", async () => {
    const billId = await makeBill({ invoiceNumber: PREFIX + "-INV-TAX", subtotal: 1000, taxTotal: 80 });
    await addBillLine(billId, { qty: 100, unitPrice: 10, glAccountId: "6000", taxCode: true });

    const result = await postBillApproval(billId);
    journalEntryIds.push(result.journalEntryId);

    const lineRows = await sql`SELECT * FROM journal_entry_lines WHERE entry_id = ${result.journalEntryId}`;
    const debitSum = lineRows.reduce((s: number, l: any) => s + Number(l.debit_amount), 0);
    const creditSum = lineRows.reduce((s: number, l: any) => s + Number(l.credit_amount), 0);
    expect(debitSum).toBe(1080);
    expect(creditSum).toBe(1080);
    expect(lineRows.some((l: any) => l.account_id === "2210" && Number(l.debit_amount) === 80)).toBe(true);
  });

  it("is idempotent: a second call for the same bill returns the existing entry, not a new one", async () => {
    const billId = await makeBill({ invoiceNumber: PREFIX + "-INV-IDEMP", subtotal: 500 });
    await addBillLine(billId, { qty: 50, unitPrice: 10, glAccountId: "6000" });

    const first = await postBillApproval(billId);
    journalEntryIds.push(first.journalEntryId);
    const second = await postBillApproval(billId);

    expect(second.alreadyPosted).toBe(true);
    expect(second.journalEntryId).toBe(first.journalEntryId);

    const entries = await sql`SELECT count(*)::int as n FROM journal_entries WHERE source_type = 'vendor_bill' AND source_id = ${billId}`;
    expect(entries[0].n).toBe(1);
  });

  it("throws when a bill line has neither its own gl_account_id nor a PO line to fall back to", async () => {
    const billId = await makeBill({ invoiceNumber: PREFIX + "-INV-NOACCT", subtotal: 500 });
    await addBillLine(billId, { qty: 50, unitPrice: 10 }); // no glAccountId, no PO
    await expect(postBillApproval(billId)).rejects.toThrow(/gl_account_id/);
  });
});

describe("postPayment (live DB)", () => {
  it("posts a single-bill payment and marks the bill paid once fully covered", async () => {
    const billId = await makeBill({ invoiceNumber: PREFIX + "-INV-PAY1", subtotal: 1000, apAccountId: "2000" });
    await addBillLine(billId, { qty: 100, unitPrice: 10, glAccountId: "6000" });
    const posted = await postBillApproval(billId);
    journalEntryIds.push(posted.journalEntryId);

    const paymentId = await makePayment({ totalAmount: 1000 });
    const result = await postPayment(paymentId, [{ vendorBillId: billId, appliedAmount: 1000 }]);
    journalEntryIds.push(result.journalEntryId);
    expect(result.alreadyPosted).toBe(false);

    const billRows = await sql`SELECT status FROM vendor_bills WHERE id = ${billId}`;
    expect(billRows[0].status).toBe("paid");

    const appRows = await sql`SELECT * FROM payment_applications WHERE payment_id = ${paymentId}`;
    expect(appRows).toHaveLength(1);
    expect(Number(appRows[0].applied_amount)).toBe(1000);
  });

  it("splits one payment across two bills and marks both paid", async () => {
    const billA = await makeBill({ invoiceNumber: PREFIX + "-INV-SPLIT-A", subtotal: 600, apAccountId: "2000" });
    await addBillLine(billA, { qty: 60, unitPrice: 10, glAccountId: "6000" });
    const billB = await makeBill({ invoiceNumber: PREFIX + "-INV-SPLIT-B", subtotal: 400, apAccountId: "2000" });
    await addBillLine(billB, { qty: 40, unitPrice: 10, glAccountId: "6000" });
    const postedA = await postBillApproval(billA);
    const postedB = await postBillApproval(billB);
    journalEntryIds.push(postedA.journalEntryId, postedB.journalEntryId);

    const paymentId = await makePayment({ totalAmount: 1000 });
    const result = await postPayment(paymentId, [
      { vendorBillId: billA, appliedAmount: 600 },
      { vendorBillId: billB, appliedAmount: 400 },
    ]);
    journalEntryIds.push(result.journalEntryId);

    const lineRows = await sql`SELECT * FROM journal_entry_lines WHERE entry_id = ${result.journalEntryId}`;
    expect(lineRows).toHaveLength(3); // 2 AP debit lines + 1 Cash credit line

    const bills = await sql`SELECT id, status FROM vendor_bills WHERE id = ANY(${[billA, billB]})`;
    expect(bills.every((b: any) => b.status === "paid")).toBe(true);
  });

  it("a partial payment does not flip the bill to paid", async () => {
    const billId = await makeBill({ invoiceNumber: PREFIX + "-INV-PARTIAL", subtotal: 1000, apAccountId: "2000" });
    await addBillLine(billId, { qty: 100, unitPrice: 10, glAccountId: "6000" });
    const posted = await postBillApproval(billId);
    journalEntryIds.push(posted.journalEntryId);

    const paymentId = await makePayment({ totalAmount: 400 });
    const result = await postPayment(paymentId, [{ vendorBillId: billId, appliedAmount: 400 }]);
    journalEntryIds.push(result.journalEntryId);

    const billRows = await sql`SELECT status FROM vendor_bills WHERE id = ${billId}`;
    expect(billRows[0].status).toBe("posted"); // not yet 'paid'
  });

  it("is idempotent: a second call for the same payment returns the existing entry", async () => {
    const billId = await makeBill({ invoiceNumber: PREFIX + "-INV-PAYIDEMP", subtotal: 200, apAccountId: "2000" });
    await addBillLine(billId, { qty: 20, unitPrice: 10, glAccountId: "6000" });
    const posted = await postBillApproval(billId);
    journalEntryIds.push(posted.journalEntryId);

    const paymentId = await makePayment({ totalAmount: 200 });
    const first = await postPayment(paymentId, [{ vendorBillId: billId, appliedAmount: 200 }]);
    journalEntryIds.push(first.journalEntryId);
    const second = await postPayment(paymentId, [{ vendorBillId: billId, appliedAmount: 200 }]);

    expect(second.alreadyPosted).toBe(true);
    expect(second.journalEntryId).toBe(first.journalEntryId);

    const apps = await sql`SELECT count(*)::int as n FROM payment_applications WHERE payment_id = ${paymentId}`;
    expect(apps[0].n).toBe(1); // not double-inserted
  });
});
