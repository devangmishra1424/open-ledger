import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getSql } from "@/db/client";
import { HttpError } from "@/lib/http";
import { createBill } from "@/lib/bills";
import { createPurchaseOrder, listPurchaseOrders } from "@/lib/purchase-orders";
import { detectBankChangeGate } from "@/lib/ledger/bank-change-review";
import { postBillApproval } from "@/lib/ledger/journal";
import { spreadTax, statedTaxRate } from "@/lib/tax-lines";
import type { Claim } from "@/lib/types";

/**
 * The four cases that used to be possible only in the seeded demo data, entered the way a person enters them: a
 * blanket order with a spending limit, a credit note, an invoice asking to be paid into a new bank account, and an
 * invoice whose tax does not fit the rate it prints. Each goes through the public entry points into the real match
 * step (test-schema database), which must then find it and record its figures. No AI call is made: the background
 * pipeline the save route starts is captured, not run.
 */

vi.mock("@/lib/background", () => ({ runInBackground: vi.fn() }));
const { runMatchStageDecision } = await import("@/lib/pipeline/orchestrator");
const { getFrontendInvoice } = await import("@/lib/api-shapes");
const poRoute = await import("@/app/api/purchase-orders/route");
const readRoute = await import("@/app/api/documents/read/route");
const saveRoute = await import("@/app/api/invoices/from-document/route");

beforeAll(() => vi.stubEnv("GROQ_API_KEY", ""));

const sql = getSql();
const TAG = `RIC-${randomUUID().slice(0, 6)}`;
const vendorName = (what: string) => `${TAG} ${what} ${randomUUID().slice(0, 4)}`;
const json = (body: unknown) => new Request("http://test/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** The figures recorded with each finding on the bill's match step, by code. */
async function recorded(billId: string): Promise<Record<string, Claim["shown"]>> {
  const { decision } = await runMatchStageDecision(billId);
  const claims = decision.claims ?? [];
  const out: Record<string, Claim["shown"]> = {};
  claims.forEach((c, i) => {
    const code = /^(EXC-[A-Z_]+): /.exec(c.text)?.[1];
    if (code && claims[i + 1]?.shown) out[code] = claims[i + 1].shown;
  });
  return out;
}
const figures = (shown: Claim["shown"]) => shown!.points.filter((p) => p.source !== "rule").map((p) => `${p.label}: ${p.value}${p.wrong ? " (wrong)" : ""}`);

describe("a blanket order: a spending limit typed on the PO form", () => {
  it("is saved as a blanket order, and an invoice that takes the total past it is caught with its figures", async () => {
    const created = await createPurchaseOrder({
      vendorName: vendorName("Blanket"), poNumber: `${TAG}-B1`, currency: "USD", spendingLimit: 1000,
      lines: [{ description: "Maintenance Kit", quantity: 40, unitPrice: 62.5 }], receipt: { inFull: true, receiptDate: "2026-10-10" },
    });
    expect((await listPurchaseOrders(200)).find((p) => p.id === created.poId)?.spendingLimit).toBe(1000);

    const earlier = await createBill({ vendorId: created.vendorId, poId: created.poId, invoiceNumber: `${TAG}-B-1`, invoiceDate: "2026-10-10", lines: [{ description: "Maintenance Kit", quantity: 10, unitPrice: 62.5 }], strictTotals: true });
    await sql`UPDATE vendor_bills SET status = 'posted' WHERE id = ${earlier.billId}`; // an earlier invoice, already approved
    const now = await createBill({ vendorId: created.vendorId, poId: created.poId, invoiceNumber: `${TAG}-B-2`, invoiceDate: "2026-10-12", lines: [{ description: "Maintenance Kit", quantity: 8, unitPrice: 62.5 }], strictTotals: true });

    const shown = (await recorded(now.billId))["EXC-BLANKET_EXCEEDED"];
    expect(shown?.title).toBe("Spending limit on the order exceeded");
    expect(figures(shown)).toEqual([
      `Spending limit on ${TAG}-B1: USD 1,000.00`, "Already billed on earlier invoices: USD 625.00", "This invoice: USD 500.00",
      "Over the limit: USD 125.00 (12.5%), with USD 1,125.00 billed in all (wrong)",
    ]);
    expect((await getFrontendInvoice(now.billId))?.mismatches.map((m) => m.title)).toContain("Spending limit on the order exceeded");
  });

  it("a PO with no limit stays a normal order; a limit that is not a positive number is refused", async () => {
    const plain = await createPurchaseOrder({ vendorName: vendorName("Plain"), poNumber: `${TAG}-P1`, lines: [{ description: "Bolt", quantity: 1, unitPrice: 1 }] });
    const [row] = await sql`SELECT po_type, max_value_ceiling FROM purchase_orders WHERE id = ${plain.poId}`;
    expect(row).toMatchObject({ po_type: "standard", max_value_ceiling: null });

    const bad = async (spendingLimit: unknown) => (await poRoute.POST(json({ vendor: vendorName("Bad"), poNumber: `${TAG}-X${randomUUID().slice(0, 4)}`, spendingLimit, items: [{ description: "Bolt", qty: 1, rate: 1 }] }), undefined as never));
    expect((await bad("lots")).status).toBe(400);
    const negative = await bad(-5);
    expect(negative.status).toBe(400);
    expect((await negative.json()).error).toMatch(/spending limit must be greater than 0/);
  });
});

describe("a credit note", () => {
  it("is recognised on the document, with the vendor's invoice it credits found on file, and the bank account read", async () => {
    const vendor = vendorName("Credit");
    await createBill({ vendorName: vendor, invoiceNumber: `${TAG}-INV-1`, invoiceDate: "2026-10-01", lines: [{ description: "Widgets", quantity: 10, unitPrice: 100 }], strictTotals: true });
    const text = [
      "CREDIT NOTE", `Vendor: ${vendor}`, `Invoice Number: CN-${TAG}`, "Invoice Date: 2026-10-10", `For returned goods on invoice ${TAG}-INV-1`,
      "Line Items:", "1. Returned widgets", "   Qty: 5", "   Unit Price: $100.00", "---", "Subtotal: $500.00", "Total: $500.00",
      "Bank: HDFC Bank, A/c 50200087761234, IFSC HDFC0001234.",
    ].join("\n");
    const res = await readRoute.POST(json({ purpose: "invoice", text }), undefined as never);
    expect(res.status).toBe(201);
    const { books } = await res.json();
    expect(books.creditNote).toMatchObject({ detected: true, creditedInvoice: { number: `${TAG}-INV-1` } });
    expect(books.bank).toEqual({ onInvoice: "1234", onFile: null });
  });

  it("is saved as a credit memo against that invoice, and the match step nets it against what is still owed", async () => {
    const vendor = vendorName("Credit");
    const original = await createBill({ vendorName: vendor, invoiceNumber: `${TAG}-INV-2`, invoiceDate: "2026-10-01", lines: [{ description: "Widgets", quantity: 10, unitPrice: 100 }], strictTotals: true });
    await sql`UPDATE vendor_bills SET status = 'posted' WHERE id = ${original.billId}`; // approved, nothing paid yet: 1,000 open
    const credit = await createBill({ vendorName: vendor, invoiceNumber: `CN-${TAG}-2`, invoiceDate: "2026-10-10", creditMemoFor: `${TAG}-INV-2`, lines: [{ description: "Returned widgets", quantity: 15, unitPrice: 100 }], strictTotals: true });
    const [row] = await sql`SELECT invoice_type, related_invoice_id FROM vendor_bills WHERE id = ${credit.billId}`;
    expect(row).toEqual({ invoice_type: "credit_memo", related_invoice_id: original.billId });

    const shown = (await recorded(credit.billId))["EXC-CREDIT_MEMO"];
    expect(shown?.title).toBe("Credit is more than is still owed on its invoice");
    expect(figures(shown)).toEqual(["Credit on this document: USD 1,500.00 (wrong)", `Invoice ${TAG}-INV-2: USD 1,000.00 still open`, "More than is open: USD 500.00 (wrong)"]);
  });

  it("naming an invoice that is not on file is refused, so a credit never goes in with nothing to check it against", async () => {
    const err = await createBill({ vendorName: vendorName("Credit"), invoiceNumber: `CN-${TAG}-3`, creditMemoFor: "NOT-ON-FILE", lines: [{ description: "x", quantity: 1, unitPrice: 1 }], strictTotals: true }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 422 });
    expect(err.message).toMatch(/no invoice NOT-ON-FILE from this vendor is on file/);
  });
});

describe("the bank account an invoice asks to be paid into", () => {
  it("the first is kept, the same again changes nothing, a different one holds the vendor and is shown against the old", async () => {
    const vendor = vendorName("Bank");
    const bill = (n: number, bankLast4: string) => createBill({ vendorName: vendor, invoiceNumber: `${TAG}-K-${n}`, invoiceDate: "2026-10-10", bankLast4, lines: [{ description: "Service", quantity: 1, unitPrice: 100 }], strictTotals: true });

    const first = await bill(1, "1111");
    expect(first.bankAccount).toBe("first");
    expect((await detectBankChangeGate(first.vendorId)).gating).toBe(false);
    expect((await bill(2, "1111")).bankAccount).toBe("same");

    const changed = await bill(3, "2222");
    expect(changed.bankAccount).toBe("changed");
    const gate = await detectBankChangeGate(changed.vendorId);
    expect(gate).toMatchObject({ gating: true, status: "callback_pending", review: { oldBankLast4: "1111", newBankLast4: "2222", sourceInvoiceId: changed.billId } });

    const shown = (await recorded(changed.billId))["EXC-FRAUD_BANK"];
    expect(figures(shown)).toEqual(["Account on file before: ending 1111", "Account on this invoice: ending 2222 (wrong)", "Confirmed by phone: Not yet (wrong)"]);
  });

  it("an invoice that is refused saves no bank change either (one transaction), and a malformed account is refused", async () => {
    const vendor = vendorName("Bank");
    const first = await createBill({ vendorName: vendor, invoiceNumber: `${TAG}-K-9`, bankLast4: "5555", lines: [{ description: "Service", quantity: 1, unitPrice: 100 }], strictTotals: true });
    const dup = await createBill({ vendorName: vendor, invoiceNumber: `${TAG}-K-9`, bankLast4: "6666", lines: [{ description: "Service", quantity: 1, unitPrice: 100 }], strictTotals: true }).catch((e) => e);
    expect(dup).toMatchObject({ status: 409 });
    const [v] = await sql`SELECT bank_account_last4, bank_account_changed_at FROM vendors WHERE id = ${first.vendorId}`;
    expect(v).toEqual({ bank_account_last4: "5555", bank_account_changed_at: null });

    const bad = await createBill({ vendorName: vendor, invoiceNumber: `${TAG}-K-10`, bankLast4: "12a4", lines: [{ description: "Service", quantity: 1, unitPrice: 100 }], strictTotals: true }).catch((e) => e);
    expect(bad).toMatchObject({ status: 400 });
  });
});

describe("the tax charged against the rate the invoice prints", () => {
  async function taxedInvoice(n: number, label: string, tax: number) {
    const po = await createPurchaseOrder({ vendorName: vendorName("Tax"), poNumber: `${TAG}-T${n}`, lines: [{ description: "Widgets", quantity: 10, unitPrice: 100 }], receipt: { inFull: true, receiptDate: "2026-10-10" } });
    const taxLines = [{ label, amount: tax }];
    const stated = statedTaxRate(taxLines)!;
    const perLine = spreadTax({ charged: tax, items: [1000], charges: [], discount: 0, rate: stated.rate })!;
    return createBill({ vendorId: po.vendorId, poId: po.poId, invoiceNumber: `${TAG}-T-${n}`, invoiceDate: "2026-10-10", tax, lines: [{ description: "Widgets", quantity: 10, unitPrice: 100 }], statedTax: { ...stated, perLine }, strictTotals: true });
  }

  it("20% charged on an invoice that says GST 18% is caught, with the printed rate and the overcharge", async () => {
    const bill = await taxedInvoice(1, "GST 18%", 200);
    const shown = (await recorded(bill.billId))["EXC-TAX_VAR"];
    expect(shown?.title).toBe("Charged more tax than the rate allows");
    expect(figures(shown)).toEqual(['Tax charged on "Widgets": USD 200.00 (20%) (wrong)', "At the printed 18% rate: USD 180.00", "Too much tax: USD 20.00 (wrong)"]);
  });

  it("tax that fits the printed rate raises nothing, and posting the invoice is unchanged (the usual tax account)", async () => {
    const bill = await taxedInvoice(2, "GST 18%", 180);
    expect(await recorded(bill.billId)).toEqual({});
    await postBillApproval(bill.billId);
    const [taxLine] = await sql`
      SELECT a.account_number FROM journal_entry_lines jl JOIN chart_of_accounts a ON a.id = jl.account_id
      JOIN vendor_bills vb ON vb.journal_entry_id = jl.entry_id WHERE vb.id = ${bill.billId} AND jl.debit_amount = 180`;
    expect(taxLine?.account_number).toBe("2210");
  });
});

describe("saving from the review screen", () => {
  it("passes the credit note and the bank account through, and refuses an account that is not 4 digits", async () => {
    const vendor = vendorName("Saved");
    const text = [`Vendor: ${vendor}`, `Invoice Number: ${TAG}-S-1`, "Invoice Date: 2026-10-10", "Line Items:", "1. Widget", "   Qty: 2", "   Unit Price: $5.00", "---", "Subtotal: $10.00", "Total: $10.00"].join("\n");
    const { documentId } = await (await readRoute.POST(json({ purpose: "invoice", text }), undefined as never)).json();
    const invoice = { vendorName: vendor, invoiceNumber: `${TAG}-S-1`, invoiceDate: "2026-10-10", currency: "USD", lines: [{ description: "Widget", quantity: 2, unitPrice: 5 }], total: 10 };

    const bad = await saveRoute.POST(json({ documentId, reviewerName: "Priya", invoice: { ...invoice, bankLast4: "12" } }), undefined as never);
    expect(bad.status).toBe(400);
    const ok = await saveRoute.POST(json({ documentId, reviewerName: "Priya", invoice: { ...invoice, bankLast4: "4321" } }), undefined as never);
    expect(ok.status).toBe(201);
    expect((await ok.json()).bankAccount).toBe("first");
  });
});
