import { getSql } from "@/db/client";
import { matchLines, descriptionSimilarity, type InvoiceLineInput, type PoLineInput } from "@/lib/matching/line-match";
import { classifyDateGap, classifyTaxRateVariance } from "@/lib/matching/tolerance-zones";
import { computePoLineFulfillment } from "@/lib/matching/partial-handling";
import { isPlausibleUomConversion } from "@/lib/matching/uom-dimension";
import {
  evaluateNoPo, evaluateNonPo, evaluateBeforeReceipt, evaluatePriceVariance, evaluateQuantityVariance,
  evaluateCurrency, evaluateBlanketExceeded, evaluateTaxVariance, evaluateCreditMemo, evaluateUomMismatch,
  combineExceptions, type ExceptionFinding, type CombinedDecision,
} from "@/lib/matching/decision-matrix";

/**
 * The "match" pipeline stage (ENGINE.md §2.3) — Layer 1, deterministic, no LLM. Assembles
 * every exception finding from PO/GRN/invoice data and combines them via decision-matrix.ts.
 *
 * SCOPE, stated honestly rather than silently gapped: this covers 11 of 14 taxonomy codes —
 * EXC-NON_PO, EXC-NO_PO, EXC-CURRENCY, EXC-BEFORE_RCV, EXC-PRICE_VAR, EXC-QTY_VAR,
 * EXC-BLANKET_EXCEEDED, EXC-CREDIT_MEMO, EXC-TAX_VAR, EXC-UOM_MISMATCH, and (always, trivially)
 * EXC-PARTIAL. Quantity checking goes through lib/matching/partial-handling.ts's
 * computePoLineFulfillment(), which tracks cumulative received-vs-invoiced state per
 * po_line_id ACROSS invoices (spec §1.6 A/B/C) — not just this one invoice in isolation, so a
 * second partial invoice against an already-partly-consumed line is judged correctly.
 * EXC-UOM_MISMATCH needs its own second pass over whatever's left unmatched after the real
 * matching runs: line-match.ts's fuzzy and Hungarian passes both REQUIRE UoM agreement as a
 * precondition to match at all, so a genuinely UoM-mismatched line can never appear in
 * lineMatchReport.matched in the first place — it's always left in both unmatched lists. The
 * pass below re-checks those specifically via UoM-insensitive description similarity, purely
 * to identify "probably the same item, measured differently," not to resolve quantity/price
 * agreement (found by testing this, not assumed — the first version of this code silently
 * never fired because it only looked at already-matched lines).
 * EXC-CREDIT_MEMO is handled in its own early branch (see below) since a credit memo isn't a
 * 3-way-match document at all — it nets against a prior invoice, not a PO.
 *
 * Deliberately NOT implemented here:
 *   - EXC-FRAUD_BANK: has its own dedicated gated state machine (ALGORITHMS.md §6,
 *     vendor_bank_change_reviews) — a separate workflow, not a match-stage finding. Wiring its
 *     detection in here is a planned follow-up once lib/ledger/bank-change-review.ts lands.
 * That one still has a ready evaluate*() function in decision-matrix.ts already — wiring it in
 * later is additive, not a rewrite.
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

  if (bill.invoice_type === "credit_memo") {
    // A credit memo isn't a 3-way-match document — it nets against a prior invoice, not a PO
    // (spec §2 EXC-07). Handled as its own early, isolated branch rather than flowing through
    // the rest of this function: a credit memo's total_amount is stored as a positive
    // magnitude (the credit value), with invoice_type carrying the sign meaning — letting a
    // literal negative amount flow through the PO-matching logic below risks corrupting every
    // other ABS-based computation in this file that assumes a normal positive invoice amount.
    detail.creditMemo = true;
    if (!bill.related_invoice_id) {
      // Spec's own detection condition requires a related invoice reference to net against;
      // without one there's nothing to compute "net_amount" from. Not fabricating a finding
      // for malformed data — this is a data-quality gap for a human to fix at intake, not a
      // matching exception this stage can meaningfully classify.
      detail.creditMemoNote = "no related_invoice_id set — cannot compute netting";
      return { findings, combined: combineExceptions(findings), detail };
    }
    const relatedRows = await sql`SELECT total_amount, status FROM vendor_bills WHERE id = ${bill.related_invoice_id}`;
    const related = relatedRows[0];
    if (!related) {
      detail.creditMemoNote = `related_invoice_id '${bill.related_invoice_id}' does not exist`;
      return { findings, combined: combineExceptions(findings), detail };
    }
    // Simplification, stated honestly: "remaining open amount" is treated as binary (0 once
    // 'paid', else the full total_amount) rather than tracking partial payments via
    // payment_applications — nothing in this codebase currently posts partial payments either
    // (see INTEGRATION.md's note on lib/ledger/journal.ts's postPayment being unwired), so
    // finer-grained tracking here would be precision this system can't yet back up elsewhere.
    const remainingOpenAmount = related.status === "paid" ? 0 : related.total_amount;
    const netAmount = remainingOpenAmount - bill.total_amount;
    detail.creditMemoNetAmount = netAmount;
    findings.push({ code: "EXC-CREDIT_MEMO", action: evaluateCreditMemo(netAmount) });
    return { findings, combined: combineExceptions(findings), detail };
  }

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

  // Fetched here (rather than just before line-matching, where it's also used) because the
  // blanket-PO quantity-ceiling check below needs this invoice's own line quantities too.
  const billLineRows = await sql`SELECT * FROM vendor_bill_lines WHERE vendor_bill_id = ${bill.id}`;

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

  // EXC-BLANKET_EXCEEDED (ALGORITHMS.md §7): a PO-header-level ceiling, not per-line — checked
  // against CUMULATIVE consumption across every prior invoice against this whole PO, not just
  // this one. Both the dollar and quantity ceilings use the same evaluateBlanketExceeded()
  // severity function (spec doesn't distinguish overage-by-dollars from overage-by-units); both
  // are checked independently when the PO has that ceiling set, and combineExceptions() below
  // already picks the worse one via highest-severity-wins if both somehow fire together.
  if (po.po_type === "blanket") {
    if (po.max_value_ceiling != null) {
      const priorValueRows = await sql`
        SELECT COALESCE(SUM(vb.total_amount), 0) as prior
        FROM vendor_bills vb WHERE vb.po_id = ${po.id} AND vb.id != ${bill.id}
          AND vb.status NOT IN ('processing', 'exception', 'void')`;
      const cumulativeValue = Number(priorValueRows[0]?.prior ?? 0) + bill.total_amount;
      if (cumulativeValue > po.max_value_ceiling) {
        const overagePct = (cumulativeValue - po.max_value_ceiling) / po.max_value_ceiling;
        findings.push({ code: "EXC-BLANKET_EXCEEDED", action: evaluateBlanketExceeded(overagePct) });
      }
    }
    if (po.max_qty_ceiling != null) {
      const priorQtyRows = await sql`
        SELECT COALESCE(SUM(vbl.qty_invoiced), 0) as prior
        FROM vendor_bill_lines vbl
        JOIN vendor_bills vb ON vb.id = vbl.vendor_bill_id
        JOIN purchase_order_lines pol ON pol.id = vbl.po_line_id
        WHERE pol.po_id = ${po.id} AND vb.id != ${bill.id}
          AND vb.status NOT IN ('processing', 'exception', 'void')`;
      const currentInvoiceQty = billLineRows.reduce((s: number, r: any) => s + r.qty_invoiced, 0);
      const cumulativeQty = Number(priorQtyRows[0]?.prior ?? 0) + currentInvoiceQty;
      if (cumulativeQty > po.max_qty_ceiling) {
        const overagePct = (cumulativeQty - po.max_qty_ceiling) / po.max_qty_ceiling;
        findings.push({ code: "EXC-BLANKET_EXCEEDED", action: evaluateBlanketExceeded(overagePct) });
      }
    }
    detail.blanketPo = { maxValueCeiling: po.max_value_ceiling, maxQtyCeiling: po.max_qty_ceiling };
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

  // EXC-UOM_MISMATCH (ALGORITHMS.md §14): a real architectural tension, found while testing
  // this, not assumed — line-match.ts's own fuzzy and Hungarian passes both REQUIRE UoM
  // agreement as a precondition to match a line at all (see line-match.ts's own uomCompatible
  // gate), so a genuinely UoM-mismatched line can never appear in lineMatchReport.matched in
  // the first place; it surfaces here as an unmatched line on both sides instead. Detecting
  // it therefore means a second, UoM-INSENSITIVE description-similarity pass over what's left
  // unmatched after the real matching already ran — reusing the same >=85% threshold, but
  // purely to identify "this is probably the same line item, measured differently," never to
  // resolve quantity/price agreement (that stays undecided until a conversion factor exists).
  const stillUnmatchedPoLines = [...lineMatchReport.unmatchedPoLines];
  for (const invLine of lineMatchReport.unmatchedInvoiceLines) {
    const line = invoiceLines.find((l) => l.id === invLine.invoiceLineId)!;
    const candidateIdx = stillUnmatchedPoLines.findIndex(
      (p) => p.uom !== line.uom && descriptionSimilarity(p.description, line.description) >= 0.85,
    );
    if (candidateIdx === -1) continue;
    const poLine = stillUnmatchedPoLines[candidateIdx];
    stillUnmatchedPoLines.splice(candidateIdx, 1);

    const conversionRows = await sql`
      SELECT id FROM vendor_corrections
      WHERE vendor_id = ${bill.vendor_id}
        AND ((uom_from = ${line.uom} AND uom_to = ${poLine.uom}) OR (uom_from = ${poLine.uom} AND uom_to = ${line.uom}))`;
    if (conversionRows.length === 0) {
      findings.push({ code: "EXC-UOM_MISMATCH", action: evaluateUomMismatch(isPlausibleUomConversion(line.uom, poLine.uom)) });
    }
    // A factor ON FILE resolves the mismatch without raising an exception (spec: "system
    // re-runs the match with it applied") — re-deriving quantity/price agreement through the
    // conversion itself is additional scope beyond clearing the exception, not done here.
  }

  for (const m of lineMatchReport.matched) {
    const invLine = invoiceLines.find((l) => l.id === m.invoiceLineId)!;
    const poLine = poLines.find((p) => p.id === m.poLineId)!;
    const lineAmountImpact = m.lineAmountVariance.varianceAbs;

    if (m.priceVariance.zone !== "green") {
      findings.push({ code: "EXC-PRICE_VAR", action: evaluatePriceVariance(m.priceVariance.variancePct, lineAmountImpact) });
    }

    // EXC-TAX_VAR: needs this line's ACTUAL tax (only present when the extraction/intake step
    // populated it — see lib/types.ts's VendorBillLine.taxAmount) and its tax code's EXPECTED
    // rate. Silently skipped when either is absent — nothing to compare, not an exception.
    const rawLine = billLineRows.find((r: any) => r.id === m.invoiceLineId);
    if (rawLine?.tax_amount != null && rawLine?.tax_code_id != null) {
      const taxCodeRows = await sql`SELECT rate FROM tax_codes WHERE id = ${rawLine.tax_code_id}`;
      const expectedRate = taxCodeRows[0]?.rate;
      const lineAmount = invLine.qty * invLine.unitPrice;
      if (expectedRate != null && lineAmount > 0) {
        const actualRate = rawLine.tax_amount / lineAmount;
        const taxZone = classifyTaxRateVariance(actualRate, expectedRate);
        if (taxZone.zone !== "green") {
          const expectedTaxAmount = lineAmount * expectedRate;
          const amountDiff = Math.abs(rawLine.tax_amount - expectedTaxAmount);
          findings.push({ code: "EXC-TAX_VAR", action: evaluateTaxVariance(taxZone.varianceAbs, amountDiff) });
        }
      }
    }

    // spec §1.4.2 + §1.6: quantity is checked against GRN ACCEPTED qty, not the PO's ordered
    // qty (that comparison already happened inside matchLines() as a preliminary tolerance
    // zone — this is the actual EXC-04 rule, a different, stricter dimension) — AND against
    // what prior invoices against this SAME po_line have already claimed (spec §1.6 Scenario
    // B), via lib/matching/partial-handling.ts. Without qtyInvoicedPrior, a second partial
    // invoice could over-claim quantity a first invoice already consumed without being caught
    // — a real correctness gap, not a hypothetical one, closed by wiring this in.
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
