import { describe, it, expect } from "vitest";
import { toFrontendInvoice, type DecisionInput } from "@/lib/api-shapes";
import * as facts from "@/lib/matching/finding-facts";
import { buildThreeWay } from "@/lib/three-way";
import { briefPoints, mainMismatch } from "../frontend/src/lib/mismatch";

/**
 * What does not match on an invoice, as the screens get it (toFrontendInvoice -> `mismatches`): each finding as a plain
 * title and its figures, the wrong ones marked. Pure: no database.
 */

const reasons = new Map([["EXC-PRICE_VAR", { name: "Price Variance", description: "Price differs from the PO." }]]);
let n = 0;
const d = (nodeId: string, extra: Partial<DecisionInput> = {}): DecisionInput => ({ id: `d${++n}`, nodeId, agentId: "engine", hash: `h${n}`, createdAt: "2026-10-17T10:00:00Z", claims: [], ...extra });
const bill = { id: "b1", invoice_number: "INV-0850", status: "exception", total_amount: 17710, currency: "USD", received_at: "2026-10-16T09:00:00Z", invoice_date: "2026-10-10", due_date: null, po_id: "po1", po_reference: "PO-2024-1160" };
const view = (decisions: DecisionInput[], extra: Partial<Parameters<typeof toFrontendInvoice>[0]> = {}) =>
  toFrontendInvoice({ bill, vendorName: "Nexus Dynamics", taxId: null, paymentTermsCode: null, poNumber: "PO-2024-1160", decisions, lines: [], reasons, ...extra });

const price = facts.priceVariance({
  lineNumber: 1, description: "Cloud Edge Hosting Cluster", uom: "each", billedPrice: 17710, poPrice: 15400, billedQty: 1,
  variancePct: 0.15, impact: 2310, currency: "USD", action: "block",
});

describe("figures recorded with a finding", () => {
  it("each figure says who says it; the billed price and the gap are the parts marked wrong, the PO price is not", () => {
    expect(price.shown.title).toBe("Charged more than the agreed price");
    expect(price.shown.points).toEqual([
      { source: "invoice", label: 'Price on the invoice for "Cloud Edge Hosting Cluster"', value: "USD 17,710.00 each", wrong: true },
      { source: "order", label: "Agreed on the purchase order (line 1)", value: "USD 15,400.00 each" },
      { source: "difference", label: "Overcharged", value: "USD 2,310.00 more each (15%), USD 2,310.00 in total", wrong: true },
      { source: "rule", label: "Allowed", value: "Up to 2% either way. 5% or more, or more than USD 500, is blocked." },
    ]);
    // The sentence the trail and the explainer use is unchanged.
    expect(price.text).toBe(facts.priceVarianceFact({ lineNumber: 1, description: "Cloud Edge Hosting Cluster", uom: "each", billedPrice: 17710, poPrice: 15400, billedQty: 1, variancePct: 0.15, impact: 2310, currency: "USD", action: "block" }));
  });

  it("reach the screen as recorded, with the sentence beside them", () => {
    const v = view([d("match", { actionTaken: "block", reasonCode: "EXC-PRICE_VAR", claims: ["EXC-PRICE_VAR: block", price.text], shown: [null, price.shown] }), d("policy", { actionTaken: "block", reasonCode: "EXC-PRICE_VAR" })]);
    expect(v.mismatches).toEqual([{ code: "EXC-PRICE_VAR", title: price.shown.title, points: price.shown.points, text: price.text, source: "recorded" }]);
  });

  it("a finding the engine let through on its own (a partial delivery) is not listed as a problem", () => {
    const v = view([d("match", { actionTaken: "auto_approve", claims: ["EXC-PARTIAL: auto_approve"], shown: [null] })]);
    expect(v.mismatches).toEqual([]);
  });
});

describe("an older record, made before figures were recorded", () => {
  const threeWay = buildThreeWay({
    po: { po_number: "PO-2024-1160", status: "open", po_type: "standard", currency: "USD", max_value_ceiling: null },
    poLines: [{ id: "pl1", line_number: 1, description: "Cloud Edge Hosting Cluster", uom: "each", qty_ordered: 1, unit_price: 15400, tolerance_pct: 0.02 }],
    receipts: [{ id: "r1", receipt_date: "2026-10-05", receiver_name: null, condition: "accepted", final_delivery_indicator: true }],
    receiptLines: [{ goods_receipt_id: "r1", po_line_id: "pl1", qty_received: 1 }],
    billLines: [{ id: "bl1", description: "Cloud Edge Hosting Cluster", uom: "each", qty_invoiced: 1, unit_price: 17710 }],
  });
  const old = [d("match", { actionTaken: "block", reasonCode: "EXC-PRICE_VAR", claims: ["EXC-PRICE_VAR: block", "an older sentence"] })];

  it("gets the same figures, worked out from the order comparison, and says so", () => {
    const v = view(old, { threeWay });
    expect(v.mismatches).toHaveLength(1);
    expect(v.mismatches[0]).toMatchObject({ code: "EXC-PRICE_VAR", title: "Charged more than the agreed price", text: "an older sentence", source: "worked_out" });
    expect(v.mismatches[0].points.filter((p) => p.wrong).map((p) => p.value)).toEqual(["USD 17,710.00 each", "USD 2,310.00 more each (15%), USD 2,310.00 in total"]);
  });

  it("without the comparison, keeps the sentence under a plain title rather than inventing figures", () => {
    expect(view(old).mismatches).toEqual([{ code: "EXC-PRICE_VAR", title: "Price differs from the order", points: [], text: "an older sentence", source: "recorded" }]);
  });
});

describe("holds that are not from the match step", () => {
  it("a bank change: the account on file before, the new one, and that nobody has phoned yet", () => {
    const gate = { gating: true, status: "callback_pending", review: { id: "r", vendorId: "v", oldBankLast4: "4471", newBankLast4: "9012", status: "callback_pending", createdAt: "x" } } as any;
    const v = view([d("match", { actionTaken: "block_fraud_flag", reasonCode: "EXC-FRAUD_BANK", claims: ["EXC-FRAUD_BANK: block_fraud_flag", "older"] })], { gate });
    expect(v.mismatches[0].title).toBe("The vendor's bank account changed");
    expect(v.mismatches[0].points.filter((p) => p.source !== "rule").map((p) => [p.label, p.value, Boolean(p.wrong)])).toEqual([
      ["Account on file before", "ending 4471", false], ["New account", "ending 9012", true], ["Confirmed by phone", "Not yet", true],
    ]);
  });

  it("an unreadable document: how sure the reader was, against what is needed", () => {
    const v = view([d("validate", { actionTaken: "block", claims: ["readability: failed - OCR confidence 72% is below the 85% threshold and the input is not structured (XML/EDI)", "duplicate: passed"] })]);
    expect(v.mismatches).toEqual([expect.objectContaining({ code: "EXC-LAYOUT", title: "The document could not be read clearly", points: [{ source: "records", label: "How sure the reader was", value: "72%; at least 85% is needed", wrong: true }] })]);
  });
});

describe("the short form a list row shows", () => {
  it("leads with the finding behind the reason, keeps the gap, leaves the rule to the route chip", () => {
    const m = mainMismatch([{ code: "EXC-TAX_VAR", title: "t", points: [], text: null, source: "recorded" }, { code: "EXC-PRICE_VAR", title: price.shown.title, points: price.shown.points, text: price.text, source: "recorded" }], "EXC-PRICE_VAR")!;
    expect(m.code).toBe("EXC-PRICE_VAR");
    expect(briefPoints(m)).toEqual([
      { label: "Invoice", value: "USD 17,710.00 each", wrong: true },
      { label: "PO", value: "USD 15,400.00 each", wrong: false },
      { label: "Overcharged", value: "USD 2,310.00 more each (15%), USD 2,310.00 in total", wrong: true },
    ]);
  });

  it("nothing to lead with when there is no finding", () => {
    expect(mainMismatch([], "EXC-PRICE_VAR")).toBeNull();
    expect(mainMismatch(undefined, null)).toBeNull();
  });
});
