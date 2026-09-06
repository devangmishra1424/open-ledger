import type { ExceptionCode } from "@/lib/matching/decision-matrix";
import type { PurchaseOrder } from "@/lib/types";

/**
 * Cross-invoice, cross-receipt PO-line fulfillment tracking — docs/ap-three-way-match-spec.md
 * §1.6 (Scenarios A/B/C). Layer 1, pure and deterministic (ENGINE.md §1).
 *
 * Distinct from line-match.ts: that module compares ONE invoice's lines against a PO's lines
 * within a single matching pass. This module instead tracks state across MULTIPLE invoices and
 * receipts against the SAME PO line over time — how much of `purchase_order_lines.qty_ordered`
 * has actually been received (summed across `goods_receipt_lines` for that `po_line_id`) versus
 * already invoiced (summed across `vendor_bill_lines` from OTHER already-posted/approved bills for
 * that `po_line_id`) — so a second or third partial invoice against the same PO line closes it
 * correctly instead of being evaluated as if it were the only invoice ever seen.
 *
 * Like line-match.ts and pre-match-validation.ts, this takes plain pre-summed numbers, not DB row
 * shapes or live DB access — the caller (pipeline) is responsible for summing
 * `goods_receipt_lines.qty_received` and prior `vendor_bill_lines.qty_invoiced` for the
 * `po_line_id` before calling this.
 */

/** Mirrors `PurchaseOrder['status']` (lib/types.ts) — this module computes the per-line fulfillment
 * state the caller uses to decide the header-level `purchase_orders.status` update (spec §1.6
 * Scenario A: "flag the PO as partially received"). `purchase_order_lines` itself has no status
 * column (see lib/types.ts / db/schema.sql) — only the PO header does — so the caller aggregates
 * this across all of a PO's lines to decide the header value; this function reports state for one
 * line only. */
export type PoLineFulfillmentStatus = PurchaseOrder["status"];

export interface PoLineFulfillmentInput {
  poLineId: string;
  /** `purchase_order_lines.qty_ordered` for this line. */
  qtyOrdered: number;
  /** Sum of `goods_receipt_lines.qty_received` across all receipts against this `po_line_id`. */
  qtyReceived: number;
  /** Sum of `vendor_bill_lines.qty_invoiced` across all OTHER already-posted/approved bills
   * against this `po_line_id`, prior to the current invoice (spec §1.6 Scenario B's running
   * total). Zero for a PO line's first-ever invoice. */
  qtyInvoicedPrior: number;
  /** The current invoice line's `qty_invoiced` — the one being matched right now. */
  qtyInvoicedCurrent: number;
}

export interface PoLineFulfillmentResult {
  poLineId: string;
  /** How much of THIS invoice line is actually payable — capped at what's been received and not
   * already claimed by prior invoices. Never exceeds `qtyInvoicedCurrent` or the received-but-
   * unbilled remainder. */
  matchedQty: number;
  /** Portion of `qtyOrdered` still open (not yet invoiced) after this invoice. Floored at 0 —
   * an over-invoiced line (Scenario C) has no negative "open" quantity, it has `excessQty`
   * instead. */
  openQty: number;
  /** Portion of `qtyInvoicedCurrent` that exceeds what was actually available to invoice
   * (received minus already-invoiced-by-priors) — spec §1.6 Scenario C. Zero unless this
   * invoice bills for more than what's left to bill against what's been received. */
  excessQty: number;
  /** `qtyInvoicedPrior + matchedQty` — the running invoiced-to-date total after this invoice
   * (spec §1.6 Scenario B: 60, then 100). */
  qtyInvoicedToDate: number;
  poLineStatus: PoLineFulfillmentStatus;
  /** Set only when `excessQty > 0` (spec §1.6 Scenario C: "raise EXC-QTY_VAR for the 20-unit
   * delta"). Severity for this exception is NOT decided here — the caller feeds `excessQty`
   * (and its dollar impact) into decision-matrix.ts's `evaluateQuantityVariance`, the single
   * source of truth for EXC-QTY_VAR severity. */
  exceptionCode?: ExceptionCode;
}

/**
 * Computes one PO line's fulfillment state given the current invoice line plus the caller's
 * already-summed received/prior-invoiced totals for that line (spec §1.6 A/B/C).
 */
export function computePoLineFulfillment(input: PoLineFulfillmentInput): PoLineFulfillmentResult {
  const { poLineId, qtyOrdered, qtyReceived, qtyInvoicedPrior, qtyInvoicedCurrent } = input;

  // What's left to bill against what's actually been received, after prior invoices already
  // claimed their share. Floored at 0: a line already over-invoiced by priors has nothing left
  // available (that prior excess was already raised as its own exception when it happened).
  const availableToInvoice = Math.max(0, qtyReceived - qtyInvoicedPrior);
  const matchedQty = Math.min(qtyInvoicedCurrent, availableToInvoice);
  const excessQty = Math.max(0, qtyInvoicedCurrent - availableToInvoice);
  const qtyInvoicedToDate = qtyInvoicedPrior + matchedQty;
  const openQty = Math.max(0, qtyOrdered - qtyInvoicedToDate);

  let poLineStatus: PoLineFulfillmentStatus;
  if (qtyInvoicedToDate <= 0) poLineStatus = "open";
  else if (qtyInvoicedToDate >= qtyOrdered) poLineStatus = "closed";
  else poLineStatus = "partial";

  return {
    poLineId,
    matchedQty,
    openQty,
    excessQty,
    qtyInvoicedToDate,
    poLineStatus,
    exceptionCode: excessQty > 0 ? "EXC-QTY_VAR" : undefined,
  };
}
