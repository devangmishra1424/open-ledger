/**
 * Implements docs/ap-three-way-match-spec.md §1.5's tolerance table exactly. This is pure,
 * deterministic classification — Layer 1, no LLM judgment (ALGORITHMS.md §1, ENGINE.md §1).
 *
 * | Dimension             | Green (auto)      | Yellow (escalate)   | Red (block)  |
 * |------------------------|-------------------|---------------------|--------------|
 * | Unit price variance    | ≤ 2.0%            | 2.01%–5.0%          | > 5.0%       |
 * | Quantity variance      | ≤5.0% AND ≤2 units| 5.01%–15.0%         | > 15.0%      |
 * | Line amount variance   | ≤$50 OR ≤2%       | $50.01–$200.00      | > $200.00    |
 * | Grand total variance   | ≤$100 OR ≤3%      | $100.01–$500.00     | > $500.00    |
 * | Tax rate variance      | ≤0.5% (absolute)  | 0.51%–2.0%          | > 2.0%       |
 * | Date gap               | ≤3 days           | 3–7 days            | > 7 days     |
 *
 * Tie-breaking rule (spec §4.5): a variance exactly at a boundary (e.g. 2.000%) classifies
 * into the GREEN (more lenient) zone, never the stricter one.
 *
 * IMPORTANT SCOPE NOTE, found while writing the tests for this file: §1.5's table and the
 * spec's own per-exception Core Decision Table (§3.1) genuinely disagree for at least the
 * quantity dimension — §1.5 gives a wide yellow escalate band (5.01%-15%), but EXC-QTY_VAR's
 * actual rule (§3.1 line 320, plus the §3.2 dollar-threshold override) is a narrower 2-tier
 * split. This module implements §1.5 faithfully as a GENERAL reference/classifier (useful for
 * the initial "does this line auto-match at all" green/not-green determination in line-match.ts),
 * but it is NOT the source of truth for a specific exception's final severity. That lives in
 * decision-matrix.ts, sourced directly from each EXC-code's own §2/§3.1/§3.2 rules. Never wire
 * this file's yellow/red output directly into a final auto-approve/escalate/block decision.
 */

export type Zone = "green" | "yellow" | "red";

function pctVariance(actual: number, expected: number): number {
  if (expected === 0) return actual === 0 ? 0 : Infinity;
  return Math.abs(actual - expected) / Math.abs(expected);
}

/** Unit price variance: pure percentage against the PO's unit price. */
export function classifyPriceVariance(invoiceUnitPrice: number, poUnitPrice: number): { zone: Zone; variancePct: number } {
  const variancePct = pctVariance(invoiceUnitPrice, poUnitPrice);
  if (variancePct <= 0.02) return { zone: "green", variancePct };
  if (variancePct <= 0.05) return { zone: "yellow", variancePct };
  return { zone: "red", variancePct };
}

/**
 * Quantity variance: spec requires BOTH the percentage AND absolute-unit conditions to be
 * satisfied for the lenient zones — e.g. green needs "≤5.0% AND ≤2 units", not either alone.
 * A tiny percentage variance on a huge order (e.g. 0.1% of 10,000 units = 10 units) should
 * still escalate if the absolute unit count is large, which is exactly why the spec ANDs
 * these two conditions instead of using percentage alone.
 */
export function classifyQuantityVariance(invoicedQty: number, referenceQty: number): { zone: Zone; variancePct: number; varianceUnits: number } {
  const variancePct = pctVariance(invoicedQty, referenceQty);
  const varianceUnits = Math.abs(invoicedQty - referenceQty);
  if (variancePct <= 0.05 && varianceUnits <= 2) return { zone: "green", variancePct, varianceUnits };
  if (variancePct <= 0.15) return { zone: "yellow", variancePct, varianceUnits };
  return { zone: "red", variancePct, varianceUnits };
}

/** Line amount variance: green if EITHER the dollar OR the percentage condition holds (an OR, not an AND). */
export function classifyLineAmountVariance(invoiceLineAmount: number, expectedLineAmount: number): { zone: Zone; varianceAbs: number; variancePct: number } {
  const varianceAbs = Math.abs(invoiceLineAmount - expectedLineAmount);
  const variancePct = pctVariance(invoiceLineAmount, expectedLineAmount);
  if (varianceAbs <= 50 || variancePct <= 0.02) return { zone: "green", varianceAbs, variancePct };
  if (varianceAbs <= 200) return { zone: "yellow", varianceAbs, variancePct };
  return { zone: "red", varianceAbs, variancePct };
}

/** Grand total variance: same OR structure as line amount, different thresholds (spec §1.4.3). */
export function classifyGrandTotalVariance(invoiceGrandTotal: number, poTotalAmount: number): { zone: Zone; varianceAbs: number; variancePct: number } {
  const varianceAbs = Math.abs(invoiceGrandTotal - poTotalAmount);
  const variancePct = pctVariance(invoiceGrandTotal, poTotalAmount);
  if (varianceAbs <= 100 || variancePct <= 0.03) return { zone: "green", varianceAbs, variancePct };
  if (varianceAbs <= 500) return { zone: "yellow", varianceAbs, variancePct };
  return { zone: "red", varianceAbs, variancePct };
}

/** Tax rate variance: absolute percentage-point difference, not a relative percentage. */
export function classifyTaxRateVariance(invoiceTaxRate: number, expectedTaxRate: number): { zone: Zone; varianceAbs: number } {
  const varianceAbs = Math.abs(invoiceTaxRate - expectedTaxRate);
  if (varianceAbs <= 0.005) return { zone: "green", varianceAbs };
  if (varianceAbs <= 0.02) return { zone: "yellow", varianceAbs };
  return { zone: "red", varianceAbs };
}

/** Date gap in whole days between two ISO date strings (order-independent, always non-negative). */
export function classifyDateGap(dateA: string, dateB: string): { zone: Zone; gapDays: number } {
  const gapMs = Math.abs(new Date(dateA).getTime() - new Date(dateB).getTime());
  const gapDays = Math.round(gapMs / (1000 * 60 * 60 * 24));
  if (gapDays <= 3) return { zone: "green", gapDays };
  if (gapDays <= 7) return { zone: "yellow", gapDays };
  return { zone: "red", gapDays };
}
