import { getSql } from "@/db/client";
import { matchLines, descriptionSimilarity, type InvoiceLineInput, type PoLineInput } from "@/lib/matching/line-match";
import { classifyDateGap, classifyTaxRateVariance, classifyPriceVariance, classifyLineAmountVariance } from "@/lib/matching/tolerance-zones";
import { computePoLineFulfillment } from "@/lib/matching/partial-handling";
import { isPlausibleUomConversion } from "@/lib/matching/uom-dimension";
import { detectBankChangeGate, getOrCreateBankChangeReview } from "@/lib/ledger/bank-change-review";
import {
  evaluateNoPo, evaluateNonPo, evaluateBeforeReceipt, evaluatePriceVariance, evaluateQuantityVariance,
  evaluateCurrency, evaluateBlanketExceeded, evaluateTaxVariance, evaluateCreditMemo, evaluateUomMismatch,
  evaluateFraudBank, evaluateUnmatchedLine, combineExceptions, type ExceptionFinding, type CombinedDecision,
} from "@/lib/matching/decision-matrix";
import * as facts from "@/lib/matching/finding-facts";

/**
 * The "match" pipeline stage (ENGINE.md §2.3) — Layer 1, deterministic, no LLM. Assembles
 * every exception finding from PO/GRN/invoice data and combines them via decision-matrix.ts.
 *
 * SCOPE, stated honestly rather than silently gapped: this covers 13 of 15 taxonomy codes —
 * EXC-NON_PO, EXC-NO_PO, EXC-CURRENCY, EXC-BEFORE_RCV, EXC-PRICE_VAR, EXC-QTY_VAR,
 * EXC-BLANKET_EXCEEDED, EXC-CREDIT_MEMO, EXC-TAX_VAR, EXC-UOM_MISMATCH, EXC-UNMATCHED_LINE,
 * EXC-FRAUD_BANK, and (always, trivially) EXC-PARTIAL. EXC-DUPLICATE and EXC-LAYOUT are validate-stage findings
 * (pre-match-validation.ts), not this stage's concern. EXC-FRAUD_BANK is detected here (via
 * lib/ledger/bank-change-review.ts's detectBankChangeGate()) but its own gated state machine
 * (callback logging, second-reviewer sign-off) lives entirely in that module, called from
 * wherever the human review actions happen — this stage only detects and cascade-stops.
 * Quantity checking goes through lib/matching/partial-handling.ts's
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
 */

export interface MatchStageResult {
  findings: ExceptionFinding[];
  combined: CombinedDecision;
  /** Plain, LLM-readable summary — this is what gets serialized as investigate()'s initialInput. */
  detail: Record<string, unknown>;
  /** For a clean match only: what was compared and found to agree, recorded as the match step's claim. */
  cleanFact?: string;
}

/** Pushes a finding with its action decided once, so the fact sentence quotes the action the engine really chose. */
function addFinding(findings: ExceptionFinding[], code: ExceptionFinding["code"], action: ExceptionFinding["action"], fact: (a: ExceptionFinding["action"]) => string) {
  findings.push({ code, action, fact: fact(action) });
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

  // EXC-FRAUD_BANK (ALGORITHMS.md §6) — checked FIRST and unconditionally, ahead of even the
  // credit-memo/non-PO/no-PO branches: it's the highest-precedence cascade-stop code (rank 1
  // in decision-matrix.ts's PRECEDENCE_RANK), and a vendor with an unresolved bank-change gate
  // is exactly as suspect for a credit memo or non-PO invoice as for a normal 3-way-match one.
  const bankGate = await detectBankChangeGate(bill.vendor_id);
  if (bankGate.gating) {
    // Idempotent: creates the review row only if this specific change has no row yet (e.g. the
    // vendor's own trust_tier/bank_account_changed_at flagged it before any invoice arrived to
    // trigger detection) — match-stage's own resolved output being saved, same precedent as
    // the po_line_id persistence below, not a business judgment call.
    if (!bankGate.review) {
      await getOrCreateBankChangeReview({ vendorId: bill.vendor_id, newBankLast4: vendor.bank_account_last4, sourceInvoiceId: bill.id });
    }
    detail.bankChangeGateStatus = bankGate.status;
    addFinding(findings, "EXC-FRAUD_BANK", evaluateFraudBank(), (action) => facts.bankChangeFact({ status: bankGate.status, action }));
    return { findings, combined: combineExceptions(findings), detail };
  }

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
    const relatedRows = await sql`SELECT total_amount, status, invoice_number FROM vendor_bills WHERE id = ${bill.related_invoice_id}`;
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
    addFinding(findings, "EXC-CREDIT_MEMO", evaluateCreditMemo(netAmount), (action) => facts.creditMemoFact({
      credit: bill.total_amount, currency: bill.currency, relatedNumber: related.invoice_number ?? null, relatedStatus: related.status,
      openAmount: remainingOpenAmount, net: netAmount, action,
    }));
    return { findings, combined: combineExceptions(findings), detail };
  }

  if (!bill.po_id) {
    // No PO reference at all — spec §2 EXC-06's own detection condition covers exactly this
    // ("po_number IS NULL AND vendor not whitelisted"); its dollar/whitelist-tiered table is
    // the more informative fit here than EXC-01's flat always-escalate rule (reserved below
    // for when a reference EXISTS but is invalid — a data-integrity problem, not a business-
    // as-usual non-PO purchase).
    const vendorWhitelisted = vendor.trust_tier === "trusted";
    addFinding(findings, "EXC-NON_PO", evaluateNonPo(bill.total_amount, vendorWhitelisted), (action) => facts.nonPoFact({
      amount: bill.total_amount, currency: bill.currency, printedPoReference: bill.po_reference ?? null, trustTier: vendor.trust_tier, action,
    }));
    detail.poReference = null;
    return { findings, combined: combineExceptions(findings), detail };
  }

  const poRows = await sql`SELECT * FROM purchase_orders WHERE id = ${bill.po_id}`;
  const po = poRows[0];
  if (!po || po.status === "closed") {
    detail.poReference = po?.po_number ?? bill.po_id;
    detail.poStatus = po?.status ?? "not_found";
    addFinding(findings, "EXC-NO_PO", evaluateNoPo(), (action) => facts.noPoFact({ poReference: po?.po_number ?? bill.po_reference ?? "it refers to", poStatus: String(detail.poStatus), action }));
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
    addFinding(findings, "EXC-CURRENCY", evaluateCurrency(true, rateVariancePct, bill.total_amount * rateVariancePct), (action) => facts.currencyFact({
      billCurrency: bill.currency, poCurrency: po.currency, poNumber: po.po_number, billRate: bill.exchange_rate, poRate: po.exchange_rate, ratePct: rateVariancePct, action,
    }));
  } else if (bill.exchange_rate !== po.exchange_rate) {
    const rateVariancePct = Math.abs(bill.exchange_rate - po.exchange_rate) / po.exchange_rate;
    addFinding(findings, "EXC-CURRENCY", evaluateCurrency(false, rateVariancePct, bill.total_amount * rateVariancePct), (action) => facts.currencyFact({
      billCurrency: bill.currency, poCurrency: po.currency, poNumber: po.po_number, billRate: bill.exchange_rate, poRate: po.exchange_rate, ratePct: rateVariancePct, action,
    }));
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
        addFinding(findings, "EXC-BLANKET_EXCEEDED", evaluateBlanketExceeded(overagePct), (action) => facts.blanketValueFact({
          poNumber: po.po_number, ceiling: Number(po.max_value_ceiling), prior: Number(priorValueRows[0]?.prior ?? 0), current: bill.total_amount, currency: bill.currency, action,
        }));
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
        addFinding(findings, "EXC-BLANKET_EXCEEDED", evaluateBlanketExceeded(overagePct), (action) => facts.blanketQtyFact({
          poNumber: po.po_number, ceiling: Number(po.max_qty_ceiling), prior: Number(priorQtyRows[0]?.prior ?? 0), current: currentInvoiceQty, action,
        }));
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
    addFinding(findings, "EXC-BEFORE_RCV", evaluateBeforeReceipt(false, 0, bill.total_amount), (action) => facts.beforeReceiptFact({
      poNumber: po.po_number, invoiceDate: String(bill.invoice_date), earliestReceipt: null, action,
    }));
    detail.goodsReceiptStatus = "none_yet";
  } else {
    const gap = classifyDateGap(bill.invoice_date, earliestReceiptDate);
    const invoiceIsBeforeReceipt = new Date(bill.invoice_date).getTime() < new Date(earliestReceiptDate).getTime();
    if (invoiceIsBeforeReceipt && gap.gapDays > 7) {
      addFinding(findings, "EXC-BEFORE_RCV", evaluateBeforeReceipt(true, gap.gapDays, bill.total_amount), (action) => facts.beforeReceiptFact({
        poNumber: po.po_number, invoiceDate: String(bill.invoice_date), earliestReceipt: String(earliestReceiptDate), gapDays: gap.gapDays, action,
      }));
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

  // Every unit-of-measure conversion this vendor has on file (a handful at most), loaded once: a
  // line billed in another unit is checked in the PO line's unit, and earlier invoices' lines
  // against a PO line are added up in that one unit.
  const conversionRows = await sql`
    SELECT uom_from, uom_to, conversion_factor FROM vendor_corrections
    WHERE vendor_id = ${bill.vendor_id} AND uom_from IS NOT NULL AND uom_to IS NOT NULL AND conversion_factor IS NOT NULL`;
  /** How many `fromUom` make one `poUom` (1 when they are the same), or null when no usable conversion is on file. */
  const unitsPerPoUnit = (fromUom: string | null | undefined, poUom: string | null | undefined): number | null => {
    if (!fromUom || !poUom || fromUom === poUom) return 1;
    for (const c of conversionRows) {
      const factor = Number(c.conversion_factor); // stored as: 1 uom_from = factor uom_to
      if (!Number.isFinite(factor) || factor <= 0) continue;
      if (c.uom_from === poUom && c.uom_to === fromUom) return factor;
      if (c.uom_from === fromUom && c.uom_to === poUom) return 1 / factor;
    }
    return null;
  };
  // Converted quantities and prices are rounded so that 1/12-style factors do not leave a
  // 0.0000001 "excess" that would raise a false quantity exception.
  const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

  /** One invoice line to check against one PO line, with its quantity and unit price in the PO line's unit. */
  interface LineToCheck { invoiceLineId: string; poLine: PoLineInput; qty: number; unitPrice: number }
  const convertedLines: LineToCheck[] = [];

  // EXC-UOM_MISMATCH (ALGORITHMS.md §14): a real architectural tension, found while testing
  // this, not assumed — line-match.ts's own fuzzy and Hungarian passes both REQUIRE UoM
  // agreement as a precondition to match a line at all (see line-match.ts's own uomCompatible
  // gate), so a genuinely UoM-mismatched line can never appear in lineMatchReport.matched in
  // the first place; it surfaces here as an unmatched line on both sides instead. Detecting
  // it therefore means a second, UoM-INSENSITIVE description-similarity pass over what's left
  // unmatched after the real matching already ran — reusing the same >=85% threshold — to
  // identify "this is probably the same line item, measured differently."
  const stillUnmatchedPoLines = [...lineMatchReport.unmatchedPoLines];
  // Invoice lines this pass accounts for (a likely unit-of-measure difference, flagged or
  // resolved by a conversion on file), so the unmatched-line check below doesn't count them twice.
  const uomPairedInvoiceLineIds = new Set<string>();
  for (const invLine of lineMatchReport.unmatchedInvoiceLines) {
    const line = invoiceLines.find((l) => l.id === invLine.invoiceLineId)!;
    const candidateIdx = stillUnmatchedPoLines.findIndex(
      (p) => p.uom !== line.uom && descriptionSimilarity(p.description, line.description) >= 0.85,
    );
    if (candidateIdx === -1) continue;
    const poLine = stillUnmatchedPoLines[candidateIdx];
    stillUnmatchedPoLines.splice(candidateIdx, 1);
    uomPairedInvoiceLineIds.add(line.id);

    const perPoUnit = unitsPerPoUnit(line.uom, poLine.uom);
    if (perPoUnit === null) {
      const plausible = isPlausibleUomConversion(line.uom, poLine.uom);
      addFinding(findings, "EXC-UOM_MISMATCH", evaluateUomMismatch(plausible), (action) => facts.uomMismatchFact({
        invoiceDescription: line.description, invoiceUom: line.uom, poLineNumber: poLine.lineNumber, poDescription: poLine.description, poUom: poLine.uom, plausible, action,
      }));
      continue;
    }
    // A conversion ON FILE resolves the unit difference (spec: "system re-runs the match with it
    // applied"), and the line is then checked like any matched line, with its quantity and price
    // expressed in the PO line's unit. Before, a conversion on file only cleared the exception
    // and skipped every check, so 480 "each" against a PO for 10 cases of 24 (twice what was
    // received) went through as clean. Linked to the PO line like a matched line, so a later
    // invoice against the same line counts it.
    convertedLines.push({ invoiceLineId: line.id, poLine, qty: round6(line.qty / perPoUnit), unitPrice: round6(line.unitPrice * perPoUnit) });
    await sql`UPDATE vendor_bill_lines SET po_line_id = ${poLine.id} WHERE id = ${line.id} AND po_line_id IS NULL`;
  }
  if (convertedLines.length > 0) {
    detail.lineMatch = {
      ...(detail.lineMatch as Record<string, unknown>),
      checkedThroughUnitConversion: convertedLines.map((c) => ({ poLineNumber: c.poLine.lineNumber, poUom: c.poLine.uom, qtyInPoUnits: c.qty, unitPriceInPoUnits: c.unitPrice })),
    };
  }

  // EXC-UNMATCHED_LINE: an invoice line that matched no PO line at all, not even as a likely
  // unit-of-measure difference above. Before this check existed, such a line was only counted in
  // detail.lineMatch, so an invoice with an extra "Expedite fee $900" on a fully received PO came
  // out as a clean auto-approval. A line worth nothing (qty or price 0) changes nothing payable
  // and is not flagged.
  const orphanLines = lineMatchReport.unmatchedInvoiceLines
    .map((u) => invoiceLines.find((l) => l.id === u.invoiceLineId)!)
    .filter((l) => !uomPairedInvoiceLineIds.has(l.id))
    .map((l) => ({ description: l.description, qty: l.qty, unitPrice: l.unitPrice, amount: Math.abs(l.qty * l.unitPrice) }))
    .filter((l) => l.amount >= 0.005);
  if (orphanLines.length > 0) {
    const unmatchedAmount = orphanLines.reduce((s, l) => s + l.amount, 0);
    addFinding(findings, "EXC-UNMATCHED_LINE", evaluateUnmatchedLine(unmatchedAmount), (action) => facts.unmatchedLinesFact({
      poNumber: po.po_number, lines: orphanLines, total: unmatchedAmount, currency: bill.currency, action,
    }));
    detail.lineMatch = { ...(detail.lineMatch as Record<string, unknown>), linesNotOnPo: orphanLines, amountNotOnPo: unmatchedAmount };
  }

  // Price, tax and quantity checks, the same for a directly matched line and a converted one.
  const linesToCheck: LineToCheck[] = [
    ...lineMatchReport.matched.map((m) => {
      const invLine = invoiceLines.find((l) => l.id === m.invoiceLineId)!;
      return { invoiceLineId: m.invoiceLineId, poLine: poLines.find((p) => p.id === m.poLineId)!, qty: invLine.qty, unitPrice: invLine.unitPrice };
    }),
    ...convertedLines,
  ];

  for (const l of linesToCheck) {
    const poLine = l.poLine;
    const priceVariance = classifyPriceVariance(l.unitPrice, poLine.unitPrice);
    // The line's amount against the PO price at the billed quantity (spec §1.4.1 step 5).
    const lineAmountImpact = classifyLineAmountVariance(l.unitPrice * l.qty, poLine.unitPrice * l.qty).varianceAbs;

    if (priceVariance.zone !== "green") {
      addFinding(findings, "EXC-PRICE_VAR", evaluatePriceVariance(priceVariance.variancePct, lineAmountImpact), (action) => facts.priceVarianceFact({
        lineNumber: poLine.lineNumber, description: poLine.description, uom: poLine.uom, billedPrice: l.unitPrice, poPrice: poLine.unitPrice,
        billedQty: l.qty, variancePct: priceVariance.variancePct, impact: lineAmountImpact, currency: bill.currency, action,
      }));
    }

    // EXC-TAX_VAR: needs this line's ACTUAL tax (only present when the extraction/intake step
    // populated it — see lib/types.ts's VendorBillLine.taxAmount) and its tax code's EXPECTED
    // rate. Silently skipped when either is absent — nothing to compare, not an exception.
    // The line amount is the same in any unit, so a converted line is checked the same way.
    const rawLine = billLineRows.find((r: any) => r.id === l.invoiceLineId);
    if (rawLine?.tax_amount != null && rawLine?.tax_code_id != null) {
      const taxCodeRows = await sql`SELECT rate FROM tax_codes WHERE id = ${rawLine.tax_code_id}`;
      const expectedRate = taxCodeRows[0]?.rate;
      const lineAmount = l.qty * l.unitPrice;
      if (expectedRate != null && lineAmount > 0) {
        const actualRate = rawLine.tax_amount / lineAmount;
        const taxZone = classifyTaxRateVariance(actualRate, expectedRate);
        if (taxZone.zone !== "green") {
          const expectedTaxAmount = lineAmount * expectedRate;
          const amountDiff = Math.abs(rawLine.tax_amount - expectedTaxAmount);
          addFinding(findings, "EXC-TAX_VAR", evaluateTaxVariance(taxZone.varianceAbs, amountDiff), (action) => facts.taxVarianceFact({
            description: rawLine.description, charged: rawLine.tax_amount, actualRate, expectedRate, expectedTax: expectedTaxAmount, currency: bill.currency, action,
          }));
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
      WHERE grl.po_line_id = ${poLine.id} AND gr.condition = 'accepted'`;
    const acceptedQty = Number(acceptedRows[0]?.accepted ?? 0);

    // Earlier invoices may have billed this PO line in another unit (linked through a conversion),
    // so each line is counted in the PO line's unit. One whose unit cannot be converted is counted
    // as is: it could only have been linked before conversions were checked.
    const priorRows = await sql`
      SELECT vbl.qty_invoiced, vbl.uom
      FROM vendor_bill_lines vbl JOIN vendor_bills vb ON vb.id = vbl.vendor_bill_id
      WHERE vbl.po_line_id = ${poLine.id} AND vb.id != ${bill.id}
        AND vb.status NOT IN ('processing', 'exception', 'void')`;
    const qtyInvoicedPrior = round6(priorRows.reduce((sum: number, r: any) => sum + Number(r.qty_invoiced) / (unitsPerPoUnit(r.uom, poLine.uom) ?? 1), 0));

    const fulfillment = computePoLineFulfillment({
      poLineId: poLine.id, qtyOrdered: poLine.qtyOrdered, qtyReceived: acceptedQty,
      qtyInvoicedPrior, qtyInvoicedCurrent: l.qty,
    });

    if (fulfillment.excessQty > 0) {
      const variancePct = acceptedQty === 0 ? 1 : fulfillment.excessQty / acceptedQty;
      const excessAmountImpact = fulfillment.excessQty * poLine.unitPrice;
      addFinding(findings, "EXC-QTY_VAR", evaluateQuantityVariance(variancePct, fulfillment.excessQty, excessAmountImpact), (action) => facts.quantityVarianceFact({
        lineNumber: poLine.lineNumber, description: poLine.description, uom: poLine.uom, ordered: poLine.qtyOrdered, acceptedReceived: acceptedQty,
        billedBefore: qtyInvoicedPrior, billedNow: l.qty, excess: fulfillment.excessQty, impact: excessAmountImpact, currency: bill.currency, action,
      }));
    }
  }

  const cleanFact = findings.length === 0 && linesToCheck.length > 0
    ? facts.cleanMatchFact({ poNumber: po.po_number, matchedLines: linesToCheck.length, currency: bill.currency, invoiced: billLineRows.reduce((s: number, r: any) => s + Number(r.qty_invoiced) * Number(r.unit_price), 0) })
    : undefined;
  return { findings, combined: combineExceptions(findings), detail, cleanFact };
}
