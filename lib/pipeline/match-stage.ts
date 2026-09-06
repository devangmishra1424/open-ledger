import { getSql } from "@/db/client";
import { matchLines, type InvoiceLineInput, type PoLineInput } from "@/lib/matching/line-match";
import { classifyDateGap } from "@/lib/matching/tolerance-zones";
import { computePoLineFulfillment } from "@/lib/matching/partial-handling";
import {
  evaluateNoPo, evaluateNonPo, evaluateBeforeReceipt, evaluatePriceVariance, evaluateQuantityVariance,
  evaluateCurrency, combineExceptions, type ExceptionFinding, type CombinedDecision,
} from "@/lib/matching/decision-matrix";

/**
 * The "match" pipeline stage (ENGINE.md §2.3) — Layer 1, deterministic, no LLM. Assembles
 * every exception finding from PO/GRN/invoice data and combines them via decision-matrix.ts.
 *
 * SCOPE, stated honestly rather than silently gapped: this covers EXC-NON_PO, EXC-NO_PO,
 * EXC-CURRENCY, EXC-BEFORE_RCV, EXC-PRICE_VAR, and EXC-QTY_VAR (6 of 14 taxonomy codes) —
 * the common, high-volume path. Quantity checking goes through
 * lib/matching/partial-handling.ts's computePoLineFulfillment(), which tracks cumulative
 * received-vs-invoiced state per po_line_id ACROSS invoices (spec §1.6 A/B/C) — not just this
 * one invoice in isolation, so a second partial invoice against an already-partly-consumed
 * line is judged correctly. Deliberately NOT implemented here, each for a real data reason
 * rather than time pressure alone:
 *   - EXC-TAX_VAR: vendor_bill_lines has no per-line tax_amount column, only a header-level
 *     tax_total aggregate — there's no non-fabricated way to compute a per-line "actual rate
 *     applied" from what's actually stored. Would need a schema change (a real one, flagged
 *     here rather than smuggled in as a silent migration).
 *   - EXC-CREDIT_MEMO: vendor_bills has no invoice_type flag distinguishing a credit memo
 *     from a standard bill, so there's no way to detect "this invoice IS a credit memo" from
 *     current schema at all. (EXC-PARTIAL itself IS handled — see above.)
 *   - EXC-BLANKET_EXCEEDED: needs a cumulative-consumption-to-date query across every prior
 *     invoice against a blanket PO — straightforward to add, just not done in this pass.
 *   - EXC-UOM_MISMATCH: needs a conversion-factor table that doesn't exist yet (ALGORITHMS.md
 *     §14's own resolution action assumes one gets built as a vendor_corrections extension).
 *   - EXC-FRAUD_BANK: has its own dedicated gated state machine (ALGORITHMS.md §6,
 *     vendor_bank_change_reviews) — a separate workflow, not a match-stage finding.
 * Each of these has a ready evaluate*() function in decision-matrix.ts already — wiring them
 * in later is additive, not a rewrite.
 */

export interface MatchStageResult {
  findings: ExceptionFinding[];
  combined: CombinedDecision;
  /** Plain, LLM-readable summary — this is what gets serialized as investigate()'s initialInput. */
  detail: Record<string, unknown>;
}

export async function runMatchStage(vendorBillId: string): Promise<MatchStageResult> {
  const sql = getSql();

  const billRows = await sql`SELECT * FROM vendor_bills WHERE id = ${vendorBillId}`;
  if (billRows.length === 0) throw new Error(`runMatchStage: no vendor_bill found with id '${vendorBillId}'`);
  const bill = billRows[0];

  const vendorRows = await sql`SELECT * FROM vendors WHERE id = ${bill.vendor_id}`;
  const vendor = vendorRows[0];

  const findings: ExceptionFinding[] = [];
  const detail: Record<string, unknown> = {
    invoiceNumber: bill.invoice_number, totalAmount: bill.total_amount, currency: bill.currency,
    // vendorId is load-bearing, not just informational: the Investigator's own system prompt
    // requires calling get_vendor_history before concluding on fraud/duplication, and that
    // tool needs a real vendor_id to call meaningfully. Found missing via a real, if
    // non-deterministic, test failure — the model fabricated a placeholder vendor_id rather
    // than getting one from context, then stalled instead of ever reaching submit_investigation.
    vendorId: bill.vendor_id,
  };

  if (!bill.po_id) {
    // No PO reference at all — spec §2 EXC-06's own detection condition covers exactly this
    // ("po_number IS NULL AND vendor not whitelisted"); its dollar/whitelist-tiered table is
    // the more informative fit here than EXC-01's flat always-escalate rule (reserved below
    // for when a reference EXISTS but is invalid — a data-integrity problem, not a business-
    // as-usual non-PO purchase).
    const vendorWhitelisted = vendor.trust_tier === "trusted";
    findings.push({ code: "EXC-NON_PO", action: evaluateNonPo(bill.total_amount, vendorWhitelisted) });
    detail.poReference = null;
    return { findings, combined: combineExceptions(findings), detail };
  }

  const poRows = await sql`SELECT * FROM purchase_orders WHERE id = ${bill.po_id}`;
  const po = poRows[0];
  if (!po || po.status === "closed") {
    findings.push({ code: "EXC-NO_PO", action: evaluateNoPo() });
    detail.poReference = po?.po_number ?? bill.po_id;
    detail.poStatus = po?.status ?? "not_found";
    return { findings, combined: combineExceptions(findings), detail };
  }

  detail.poReference = po.po_number;

  // Header-level currency: a literal currency mismatch, or the same currency at a different
  // exchange rate than the PO locked in. evaluateCurrency's `unsupported` param means "block,
  // no judgment" either way — a genuine currency mismatch is just as non-negotiable as an
  // unsupported currency; the pre-match-validation.ts check already gated the "not in our
  // supported list at all" case earlier in the pipeline.
  if (bill.currency !== po.currency) {
    const rateVariancePct = Math.abs(bill.exchange_rate - po.exchange_rate) / (po.exchange_rate || 1);
    findings.push({ code: "EXC-CURRENCY", action: evaluateCurrency(true, rateVariancePct, bill.total_amount * rateVariancePct) });
  } else if (bill.exchange_rate !== po.exchange_rate) {
    const rateVariancePct = Math.abs(bill.exchange_rate - po.exchange_rate) / po.exchange_rate;
    findings.push({ code: "EXC-CURRENCY", action: evaluateCurrency(false, rateVariancePct, bill.total_amount * rateVariancePct) });
  }

  // EXC-BEFORE_RCV (header-level, spec §2 EXC-02): only fires when the condition is actually
  // violated — evaluateBeforeReceipt(grnExists=true, ...) assumes its own precondition (gap>7d)
  // already held, so this function is never called for a GRN that exists with a short gap.
  const receiptRows = await sql`SELECT MIN(receipt_date) as earliest FROM goods_receipts WHERE po_id = ${po.id}`;
  const earliestReceiptDate: string | null = receiptRows[0]?.earliest ?? null;
  if (!earliestReceiptDate) {
    findings.push({ code: "EXC-BEFORE_RCV", action: evaluateBeforeReceipt(false, 0, bill.total_amount) });
    detail.goodsReceiptStatus = "none_yet";
  } else {
    const gap = classifyDateGap(bill.invoice_date, earliestReceiptDate);
    const invoiceIsBeforeReceipt = new Date(bill.invoice_date).getTime() < new Date(earliestReceiptDate).getTime();
    if (invoiceIsBeforeReceipt && gap.gapDays > 7) {
      findings.push({ code: "EXC-BEFORE_RCV", action: evaluateBeforeReceipt(true, gap.gapDays, bill.total_amount) });
    }
    detail.earliestReceiptDate = earliestReceiptDate;
  }

  const poLineRows = await sql`SELECT * FROM purchase_order_lines WHERE po_id = ${po.id} ORDER BY line_number`;
  const billLineRows = await sql`SELECT * FROM vendor_bill_lines WHERE vendor_bill_id = ${bill.id}`;

  const poLines: PoLineInput[] = poLineRows.map((r: any) => ({
    id: r.id, lineNumber: r.line_number, description: r.description, uom: r.uom, qtyOrdered: r.qty_ordered, unitPrice: r.unit_price,
  }));
  const invoiceLines: InvoiceLineInput[] = billLineRows.map((r: any) => ({
    id: r.id, description: r.description, uom: r.uom, qty: r.qty_invoiced, unitPrice: r.unit_price,
  }));

  const lineMatchReport = matchLines(invoiceLines, poLines);
  detail.lineMatch = {
    matchedCount: lineMatchReport.matched.length,
    unmatchedInvoiceLineCount: lineMatchReport.unmatchedInvoiceLines.length,
    unmatchedPoLineCount: lineMatchReport.unmatchedPoLines.length,
  };

  // Persist the resolved po_line_id — line-match.ts determines this (by exact line number,
  // fuzzy description, or Hungarian assignment), but nothing writes it back to the row unless
  // done here. Without it, every future invoice against this same PO line would see
  // qtyInvoicedPrior=0 below (the split-invoice/Scenario B query depends on this column being
  // populated), silently defeating the whole point of tracking cross-invoice fulfillment.
  // This is match-stage's own resolved output being saved, not a business decision — legitimate
  // even though the rest of this stage is otherwise read-only.
  for (const m of lineMatchReport.matched) {
    await sql`UPDATE vendor_bill_lines SET po_line_id = ${m.poLineId} WHERE id = ${m.invoiceLineId} AND po_line_id IS NULL`;
  }

  for (const m of lineMatchReport.matched) {
    const invLine = invoiceLines.find((l) => l.id === m.invoiceLineId)!;
    const lineAmountImpact = m.lineAmountVariance.varianceAbs;

    if (m.priceVariance.zone !== "green") {
      findings.push({ code: "EXC-PRICE_VAR", action: evaluatePriceVariance(m.priceVariance.variancePct, lineAmountImpact) });
    }

    // spec §1.4.2 + §1.6: quantity is checked against GRN ACCEPTED qty, not the PO's ordered
    // qty (that comparison already happened inside matchLines() as a preliminary tolerance
    // zone — this is the actual EXC-04 rule, a different, stricter dimension) — AND against
    // what prior invoices against this SAME po_line have already claimed (spec §1.6 Scenario
    // B), via lib/matching/partial-handling.ts. Without qtyInvoicedPrior, a second partial
    // invoice could over-claim quantity a first invoice already consumed without being caught
    // — a real correctness gap, not a hypothetical one, closed by wiring this in.
    const poLine = poLines.find((p) => p.id === m.poLineId)!;
    const acceptedRows = await sql`
      SELECT COALESCE(SUM(grl.qty_received), 0) as accepted
      FROM goods_receipt_lines grl JOIN goods_receipts gr ON gr.id = grl.goods_receipt_id
      WHERE grl.po_line_id = ${m.poLineId} AND gr.condition = 'accepted'`;
    const acceptedQty = Number(acceptedRows[0]?.accepted ?? 0);

    const priorRows = await sql`
      SELECT COALESCE(SUM(vbl.qty_invoiced), 0) as prior
      FROM vendor_bill_lines vbl JOIN vendor_bills vb ON vb.id = vbl.vendor_bill_id
      WHERE vbl.po_line_id = ${m.poLineId} AND vb.id != ${bill.id}
        AND vb.status NOT IN ('processing', 'exception', 'void')`;
    const qtyInvoicedPrior = Number(priorRows[0]?.prior ?? 0);

    const fulfillment = computePoLineFulfillment({
      poLineId: m.poLineId, qtyOrdered: poLine.qtyOrdered, qtyReceived: acceptedQty,
      qtyInvoicedPrior, qtyInvoicedCurrent: invLine.qty,
    });

    if (fulfillment.excessQty > 0) {
      const variancePct = acceptedQty === 0 ? 1 : fulfillment.excessQty / acceptedQty;
      const excessAmountImpact = fulfillment.excessQty * poLine.unitPrice;
      findings.push({ code: "EXC-QTY_VAR", action: evaluateQuantityVariance(variancePct, fulfillment.excessQty, excessAmountImpact) });
    }
  }

  return { findings, combined: combineExceptions(findings), detail };
}
