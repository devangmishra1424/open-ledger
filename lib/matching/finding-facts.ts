import type { Action } from "@/lib/matching/decision-matrix";

/**
 * The specific facts behind each matching finding, as one sentence a person (and the "ask why"
 * explainer, which answers only from recorded claims) can read: which line, which numbers, which
 * threshold, and where that put this invoice. Recorded next to the finding's code on the match
 * step, so "EXC-PRICE_VAR: block" says what was over and by how much.
 *
 * Pure wording over numbers match-stage.ts already computed: nothing here decides anything. The
 * thresholds quoted are the ones decision-matrix.ts applies; each sentence ends with the route
 * the engine actually chose (passed in), never one recomputed here.
 */

const ROUTE: Record<Action, string> = {
  auto_approve: "approved automatically",
  escalate_l1: "sent to a reviewer",
  escalate_l2: "sent to a reviewer at level 2",
  block: "blocked",
  auto_reject: "rejected automatically",
  block_fraud_flag: "blocked as possible fraud",
};

export function money(amount: number, currency: string): string {
  return `${currency} ${Math.abs(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const pct = (x: number) => `${(x * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
const qty = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });
const quote = (s: string) => `"${s}"`;

/** "This invoice was sent to a reviewer at level 2." — the engine's actual outcome for this finding. */
const outcome = (action: Action) => `This invoice was ${ROUTE[action]}.`;

export function priceVarianceFact(p: {
  lineNumber: number; description: string; uom: string; billedPrice: number; poPrice: number; billedQty: number;
  variancePct: number; impact: number; currency: string; action: Action;
}): string {
  const dir = p.billedPrice > p.poPrice ? "above" : "below";
  return `PO line ${p.lineNumber} ${quote(p.description)}: billed ${money(p.billedPrice, p.currency)} per ${p.uom} against the order's ${money(p.poPrice, p.currency)}, ${pct(p.variancePct)} ${dir} it (2% is tolerated). ` +
    `At the billed quantity of ${qty(p.billedQty)} that is ${money(p.impact, p.currency)} ${dir === "above" ? "more" : "less"} than agreed. ` +
    `A difference of 5% or more, or more than ${p.currency} 500, is blocked; a smaller one goes to a reviewer. ${outcome(p.action)}`;
}

export function quantityVarianceFact(p: {
  lineNumber: number; description: string; uom: string; ordered: number; acceptedReceived: number; billedBefore: number; billedNow: number;
  excess: number; impact: number; currency: string; action: Action;
}): string {
  const before = p.billedBefore > 0 ? `, ${qty(p.billedBefore)} already billed on earlier invoices` : "";
  return `PO line ${p.lineNumber} ${quote(p.description)}: ordered ${qty(p.ordered)}, received in good condition ${qty(p.acceptedReceived)}${before}, billed now ${qty(p.billedNow)}. ` +
    `That bills ${qty(p.excess)} ${p.uom} more than has arrived and not yet been billed, worth ${money(p.impact, p.currency)} at the order price. ` +
    `More than 5% or more than 2 units over is blocked; less goes to a reviewer. ${outcome(p.action)}`;
}

export function unmatchedLinesFact(p: {
  poNumber: string; lines: Array<{ description: string; qty: number; unitPrice: number; amount: number }>; total: number; currency: string; action: Action;
}): string {
  const list = p.lines.map((l) => `${quote(l.description)} (${qty(l.qty)} x ${money(l.unitPrice, p.currency)} = ${money(l.amount, p.currency)})`).join("; ");
  return `${p.lines.length === 1 ? "One invoice line is" : `${p.lines.length} invoice lines are`} not on purchase order ${p.poNumber} at all: ${list}. ` +
    `${money(p.total, p.currency)} is billed for things nobody ordered. Such lines are never approved automatically: up to ${p.currency} 1,000 a reviewer decides, up to ${p.currency} 10,000 a reviewer at level 2, above that it is blocked. ${outcome(p.action)}`;
}

export function uomMismatchFact(p: {
  invoiceDescription: string; invoiceUom: string; poLineNumber: number; poDescription: string; poUom: string; plausible: boolean; action: Action;
}): string {
  return `Invoice line ${quote(p.invoiceDescription)} is billed per ${p.invoiceUom}; it looks like PO line ${p.poLineNumber} ${quote(p.poDescription)}, which is ordered per ${p.poUom}, and no conversion between the two is on file for this vendor. ` +
    (p.plausible
      ? `The two units measure the same kind of thing, so a reviewer decides whether they match. ${outcome(p.action)}`
      : `The two units do not measure the same kind of thing, so the quantities cannot be compared. ${outcome(p.action)}`);
}

export function taxVarianceFact(p: {
  description: string; charged: number; actualRate: number; expectedRate: number; expectedTax: number; currency: string; action: Action;
}): string {
  return `Line ${quote(p.description)}: tax charged ${money(p.charged, p.currency)} (${pct(p.actualRate)} of the line) against the ${pct(p.expectedRate)} its tax code expects (${money(p.expectedTax, p.currency)}). ` +
    `More than 2 points of rate, or more than ${p.currency} 100 of tax, is blocked; less goes to a reviewer. ${outcome(p.action)}`;
}

export function blanketValueFact(p: { poNumber: string; ceiling: number; prior: number; current: number; currency: string; action: Action }): string {
  const total = p.prior + p.current;
  const over = total - p.ceiling;
  const before = p.prior > 0
    ? `Earlier cleared invoices on it total ${money(p.prior, p.currency)}; with this one (${money(p.current, p.currency)}) the order reaches`
    : "This invoice alone comes to";
  return `Blanket order ${p.poNumber} may be billed up to ${money(p.ceiling, p.currency)} in total. ${before} ${money(total, p.currency)}, ${money(over, p.currency)} (${pct(over / p.ceiling)}) over the ceiling. ` +
    `Up to 10% over, a reviewer decides at level 2; more than 10% is blocked. ${outcome(p.action)}`;
}

export function blanketQtyFact(p: { poNumber: string; ceiling: number; prior: number; current: number; action: Action }): string {
  const total = p.prior + p.current;
  return `Blanket order ${p.poNumber} may be billed for at most ${qty(p.ceiling)} units in total. ${qty(p.prior)} were billed before and ${qty(p.current)} on this invoice, ${qty(total)} in all: ${qty(total - p.ceiling)} (${pct((total - p.ceiling) / p.ceiling)}) over. ` +
    `Up to 10% over, a reviewer decides at level 2; more than 10% is blocked. ${outcome(p.action)}`;
}

export function beforeReceiptFact(p: { poNumber: string; invoiceDate: string; earliestReceipt: string | null; gapDays?: number; action: Action }): string {
  if (!p.earliestReceipt) {
    return `No delivery is recorded against purchase order ${p.poNumber} yet, so nothing on this invoice is confirmed as arrived. ` +
      `Recording the goods receipt on Orders checks the invoice again on its own. Until then it is ${ROUTE[p.action]}.`;
  }
  return `The invoice is dated ${p.invoiceDate}, ${p.gapDays} days before the first delivery against purchase order ${p.poNumber} (${p.earliestReceipt}). ` +
    `Billing more than 7 days ahead of delivery is held. ${outcome(p.action)}`;
}

export function currencyFact(p: { billCurrency: string; poCurrency: string; poNumber: string; billRate: number; poRate: number; ratePct: number; action: Action }): string {
  if (p.billCurrency !== p.poCurrency) {
    return `The invoice is in ${p.billCurrency} but purchase order ${p.poNumber} was placed in ${p.poCurrency}. This system does not convert between currencies, so the amounts cannot be compared. ${outcome(p.action)}`;
  }
  return `Invoice and purchase order ${p.poNumber} are both in ${p.billCurrency}, but the invoice uses an exchange rate of ${p.billRate} against the order's ${p.poRate} (${pct(p.ratePct)} apart). ` +
    `More than 1% apart goes to a reviewer at level 2, otherwise to a reviewer. ${outcome(p.action)}`;
}

export function nonPoFact(p: { amount: number; currency: string; printedPoReference: string | null; trustTier: string; action: Action }): string {
  const why = p.printedPoReference
    ? `The invoice prints purchase order ${p.printedPoReference}, but no such order is on file for this vendor, so it was checked as a non-PO invoice: there is no agreed price, quantity or delivery to compare it with.`
    : `The invoice refers to no purchase order, so there is no agreed price, quantity or delivery to compare it with.`;
  const band = p.amount <= 100 ? `up to ${p.currency} 100`
    : p.amount <= 1000 ? `${p.currency} 100.01 to 1,000`
    : p.amount <= 10000 ? `${p.currency} 1,000.01 to 10,000`
    : `over ${p.currency} 10,000`;
  return `${why} At ${money(p.amount, p.currency)} it falls in the ${band} band for non-PO spend (vendor trust tier: ${p.trustTier}). ` +
    `Only up to ${p.currency} 100 from a trusted vendor is approved on its own; up to 1,000 a reviewer decides, up to 10,000 a reviewer at level 2, above that it is blocked. ${outcome(p.action)}`;
}

export function noPoFact(p: { poReference: string; poStatus: string; action: Action }): string {
  const state = p.poStatus === "not_found" ? "is not on file" : `is ${p.poStatus}`;
  return `The invoice is billed against purchase order ${p.poReference}, which ${state}. An order that is missing or closed cannot be billed against. ${outcome(p.action)}`;
}

export function creditMemoFact(p: {
  credit: number; currency: string; relatedNumber: string | null; relatedStatus: string; openAmount: number; net: number; action: Action;
}): string {
  const target = p.relatedNumber ? `invoice ${p.relatedNumber}` : "the related invoice";
  if (p.relatedStatus === "void") {
    return `This is a credit of ${money(p.credit, p.currency)} against ${target}, which was rejected, so nothing was ever owed on it. ` +
      `Approving the credit would lower what you owe the vendor for money that was never owed, so a person decides it. ${outcome(p.action)}`;
  }
  const open = p.relatedStatus === "paid" ? `which is already paid, so nothing is left open on it` : `which has ${money(p.openAmount, p.currency)} still open`;
  return `This is a credit of ${money(p.credit, p.currency)} against ${target}, ${open}. ` +
    (p.net >= 0
      ? `It fits inside the open amount (leaving ${money(p.net, p.currency)}). ${outcome(p.action)}`
      : `${money(-p.net, p.currency)} of the credit is more than is open on that invoice, so a person decides it. ${outcome(p.action)}`);
}

export function bankChangeFact(p: { status: string; action: Action }): string {
  return `The vendor's bank account details changed and the change is not yet verified (review status: ${p.status}). ` +
    `Until someone phones the vendor on a number from your own records and a second person signs off, nothing is paid to this vendor. ${outcome(p.action)}`;
}

export function cleanMatchFact(p: { poNumber: string; matchedLines: number; currency: string; invoiced: number }): string {
  return `All ${p.matchedLines} invoice line${p.matchedLines === 1 ? "" : "s"} matched lines on purchase order ${p.poNumber}: every price is within 2% of the order, nothing is billed beyond what was received in good condition, and no line is outside the order. ` +
    `${money(p.invoiced, p.currency)} billed with no exception found.`;
}
