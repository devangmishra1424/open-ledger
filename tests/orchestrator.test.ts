import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getSql } from "@/db/client";
import { runPipeline } from "@/lib/pipeline/orchestrator";
import { getDecisionsForInvoice, getAllDecisionsInOrder, toChainableRecord } from "@/lib/ledger/decisions";
import { verifyChain } from "@/lib/ledger/hash-chain";

/**
 * The capstone integration test — runs the FULL 7-stage pipeline end-to-end against the live
 * DB, live OpenAI, and live TensorMux for the scenarios that actually reach investigate/verify.
 * Covers all three cascade shapes: validate-stage cascade (free — no LLM calls), match-stage
 * cascade (free), and the full non-cascaded path (real LLM calls, tier-2-eligible).
 */

const PREFIX = "TEST-ORCH";
const sql = getSql();
const vendorIds: string[] = [];
const poIds: string[] = [];
const billIds: string[] = [];

async function makeVendor(trustTier: "trusted" | "new" | "flagged" = "new") {
  const id = crypto.randomUUID();
  vendorIds.push(id);
  await sql`INSERT INTO vendors (id, name, trust_tier) VALUES (${id}, ${PREFIX + " Vendor " + id.slice(0, 8)}, ${trustTier})`;
  return id;
}

async function makePoWithLine(vendorId: string, opts: { poNumber: string; unitPrice: number; qtyOrdered: number }) {
  const poId = crypto.randomUUID();
  poIds.push(poId);
  await sql`INSERT INTO purchase_orders (id, po_number, vendor_id, order_date, status) VALUES (${poId}, ${opts.poNumber}, ${vendorId}, '2026-08-01', 'open')`;
  const lineId = crypto.randomUUID();
  await sql`
    INSERT INTO purchase_order_lines (id, po_id, line_number, description, uom, qty_ordered, unit_price)
    VALUES (${lineId}, ${poId}, 1, 'Widget', 'each', ${opts.qtyOrdered}, ${opts.unitPrice})`;
  return { poId, lineId };
}

async function acceptReceipt(poId: string, lineId: string, qty: number) {
  const receiptId = crypto.randomUUID();
  await sql`INSERT INTO goods_receipts (id, po_id, receipt_date, condition) VALUES (${receiptId}, ${poId}, '2026-08-10', 'accepted')`;
  await sql`INSERT INTO goods_receipt_lines (id, goods_receipt_id, po_line_id, qty_received) VALUES (${crypto.randomUUID()}, ${receiptId}, ${lineId}, ${qty})`;
}

async function makeBill(vendorId: string, opts: { poId?: string | null; invoiceNumber: string; totalAmount: number }) {
  const billId = crypto.randomUUID();
  billIds.push(billId);
  await sql`
    INSERT INTO vendor_bills (id, vendor_id, po_id, invoice_number, invoice_date, subtotal, total_amount)
    VALUES (${billId}, ${vendorId}, ${opts.poId ?? null}, ${opts.invoiceNumber}, '2026-08-15', ${opts.totalAmount}, ${opts.totalAmount})`;
  return billId;
}

async function addBillLine(billId: string, qty: number, unitPrice: number, glAccountId?: string) {
  await sql`
    INSERT INTO vendor_bill_lines (id, vendor_bill_id, description, qty_invoiced, unit_price, gl_account_id)
    VALUES (${crypto.randomUUID()}, ${billId}, 'Widget', ${qty}, ${unitPrice}, ${glAccountId ?? null})`;
}

afterAll(async () => {
  // Scenarios that reach auto_approve post a real journal entry (postBillApproval) — clean
  // those up too, or every run leaves permanent journal_entries/journal_entry_lines rows behind
  // that pollute real aggregate queries (e.g. GET /api/dashboard's sealedToday), found by
  // querying the live DB directly and finding this test's own bill numbers still posted weeks
  // after the run that created them.
  const entryRows = await sql`SELECT id FROM journal_entries WHERE source_type = 'vendor_bill' AND source_id = ANY(${billIds})`;
  const entryIds = entryRows.map((r: any) => r.id);
  if (entryIds.length > 0) {
    await sql`DELETE FROM journal_entry_lines WHERE entry_id = ANY(${entryIds})`;
    await sql`DELETE FROM journal_entries WHERE id = ANY(${entryIds})`;
  }
  for (const id of billIds) await sql`DELETE FROM vendor_bill_lines WHERE vendor_bill_id = ${id}`;
  // decisions is supposed to be permanently append-only — deleting rows from the middle of the
  // GLOBAL hash chain would corrupt verifyChain() for whatever real decision happened to land
  // immediately after one of this test's rows in the global seq order, by leaving that real
  // row's stored hash pointing at a prevHash that no longer exists in the walked sequence.
  // STALE PREMISE, now genuinely live (not hypothetical): this delete was written when the
  // decisions table was verified empty pre-launch — scripts/seed.ts now populates real,
  // permanent decisions rows against this same live DB, so this test suite running concurrently
  // with (or after) a seed/demo session risks exactly the corruption described above if a real
  // decision's insert happens to interleave with this test's own inserts in the global seq.
  // Scoped by billIds so it's still narrow, and no corruption has been observed in practice
  // (this test's own decisions are only ever adjacent to its own rows so far) — but this is a
  // real, load-bearing risk now, not a hypothetical one, and the right fix (a genuinely isolated
  // test database, per the original note below) hasn't been done. vendor_bills.id also has no
  // ON DELETE CASCADE from decisions.invoice_id, so this delete is separately load-bearing:
  // without it, the vendor_bills delete below would fail on the FK regardless of the above.
  await sql`DELETE FROM decisions WHERE invoice_id = ANY(${billIds})`;
  await sql`DELETE FROM vendor_bills WHERE id = ANY(${billIds})`;
  for (const id of poIds) {
    await sql`DELETE FROM goods_receipt_lines WHERE goods_receipt_id IN (SELECT id FROM goods_receipts WHERE po_id = ${id})`;
    await sql`DELETE FROM goods_receipts WHERE po_id = ${id}`;
    await sql`DELETE FROM purchase_order_lines WHERE po_id = ${id}`;
  }
  await sql`DELETE FROM purchase_orders WHERE id = ANY(${poIds})`;
  await sql`DELETE FROM vendors WHERE id = ANY(${vendorIds})`;
});

describe("runPipeline — validate-stage cascade (no LLM calls)", () => {
  // Not tested here: an exact-duplicate invoice_number. vendor_bills has a real
  // UNIQUE(vendor_id, invoice_number) constraint, so two such rows can never coexist to
  // construct this scenario against — same lesson as tools.test.ts and match-stage.test.ts.
  // The flagged-vendor case below exercises the identical code path (any pre-match gate
  // failure cascades straight to policy/audit) via a scenario that's actually constructible.
  it("a flagged vendor cascades straight to policy/audit with no match/investigate/verify rows", async () => {
    const vendorId = await makeVendor("flagged");
    const billId = await makeBill(vendorId, { invoiceNumber: PREFIX + "-FLAGGED", totalAmount: 500 });
    await addBillLine(billId, 1, 500); // extract needs at least one line to parse, same lesson as the tier-2 test below

    await runPipeline(billId);

    const decisions = await getDecisionsForInvoice(billId);
    const nodeIds = decisions.map((d) => d.nodeId);
    expect(nodeIds).toEqual(["extract", "validate", "policy", "audit"]);
    expect(decisions.find((d) => d.nodeId === "policy")?.actionTaken).toBe("block");

    const billRows = await sql`SELECT status FROM vendor_bills WHERE id = ${billId}`;
    expect(billRows[0].status).toBe("exception");
  }, 30_000);
});

describe("runPipeline — match-stage cascade (no LLM calls)", () => {
  it("a closed PO reference cascades straight to policy/audit", async () => {
    const vendorId = await makeVendor();
    const { poId } = await makePoWithLine(vendorId, { poNumber: PREFIX + "-PO-CLOSED", unitPrice: 10, qtyOrdered: 100 });
    await sql`UPDATE purchase_orders SET status = 'closed' WHERE id = ${poId}`;
    const billId = await makeBill(vendorId, { poId, invoiceNumber: PREFIX + "-CLOSEDPO", totalAmount: 1000 });
    await addBillLine(billId, 100, 10);

    await runPipeline(billId);

    const decisions = await getDecisionsForInvoice(billId);
    expect(decisions.map((d) => d.nodeId)).toEqual(["extract", "validate", "match", "policy", "audit"]);
    expect(decisions.find((d) => d.nodeId === "policy")?.actionTaken).toBe("escalate_l2");
    expect(decisions.find((d) => d.nodeId === "policy")?.reasonCode).toBe("EXC-NO_PO");
  }, 30_000);
});

describe("runPipeline — clean full path (real LLM calls, not tier-2-eligible)", () => {
  it("a clean, fully-matched invoice runs through investigate but not verify, and auto-approves", async () => {
    const vendorId = await makeVendor("trusted");
    const { poId, lineId } = await makePoWithLine(vendorId, { poNumber: PREFIX + "-PO-CLEAN", unitPrice: 10, qtyOrdered: 50 });
    await acceptReceipt(poId, lineId, 50);
    const billId = await makeBill(vendorId, { poId, invoiceNumber: PREFIX + "-CLEAN", totalAmount: 500 });
    await addBillLine(billId, 50, 10, "6000"); // real GL account so the audit stage's postBillApproval() call can actually post

    await runPipeline(billId);

    const decisions = await getDecisionsForInvoice(billId);
    expect(decisions.map((d) => d.nodeId)).toEqual(["extract", "validate", "match", "investigate", "policy", "audit"]);
    expect(decisions.find((d) => d.nodeId === "policy")?.actionTaken).toBe("auto_approve");
    expect(decisions.find((d) => d.nodeId === "policy")?.reasonCode).toBe("CLEAN_MATCH");

    // postBillApproval() (lib/ledger/journal.ts) sets status to 'posted', not just 'approved' —
    // the audit stage's real job is to actually post the journal entry, not just flag intent.
    const billRows = await sql`SELECT status, journal_entry_id FROM vendor_bills WHERE id = ${billId}`;
    expect(billRows[0].status).toBe("posted");
    expect(billRows[0].journal_entry_id).not.toBeNull();

    const jelRows = await sql`SELECT debit_amount, credit_amount FROM journal_entry_lines WHERE entry_id = ${billRows[0].journal_entry_id}`;
    const totalDebits = jelRows.reduce((s: number, r: any) => s + Number(r.debit_amount), 0);
    const totalCredits = jelRows.reduce((s: number, r: any) => s + Number(r.credit_amount), 0);
    expect(totalDebits).toBeCloseTo(500, 2);
    expect(totalDebits).toBeCloseTo(totalCredits, 2);

    // verifyChain walks the chain from genesis using its own running `prev` — it must be
    // called with the COMPLETE global sequence, not one invoice's slice, or the first
    // record's real prevHash (whatever the true prior global hash was) won't match a
    // freshly-started null.
    const allDecisions = await getAllDecisionsInOrder();
    const chainCheck = verifyChain(allDecisions.map(toChainableRecord));
    expect(chainCheck.valid).toBe(true);
  }, 60_000);
});

describe("runPipeline — full non-cascaded path with a real exception (tier-2-eligible, both LLM stages run)", () => {
  it("a high-dollar non-PO invoice runs through investigate AND verify before policy escalates it", async () => {
    const vendorId = await makeVendor("new"); // not whitelisted -> high amount forces escalate_l2/block via the dollar table
    const billId = await makeBill(vendorId, { poId: null, invoiceNumber: PREFIX + "-NONPO-BIG", totalAmount: 15000 });
    await addBillLine(billId, 1, 15000); // a non-PO invoice still needs a real line item for extract to have something to parse

    await runPipeline(billId);

    const decisions = await getDecisionsForInvoice(billId);
    expect(decisions.map((d) => d.nodeId)).toEqual(["extract", "validate", "match", "investigate", "verify", "policy", "audit"]);

    const policyDecision = decisions.find((d) => d.nodeId === "policy")!;
    expect(["escalate_l2", "block"]).toContain(policyDecision.actionTaken);
    expect(policyDecision.reasonCode).toBe("EXC-NON_PO");

    const billRows = await sql`SELECT status FROM vendor_bills WHERE id = ${billId}`;
    expect(billRows[0].status).toBe("exception");
  }, 90_000);
});
