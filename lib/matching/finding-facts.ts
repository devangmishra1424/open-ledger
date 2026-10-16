import type { Action } from "@/lib/matching/decision-matrix";
import type { FactPoint, FactShown } from "@/lib/types";

/**
 * The specific facts behind each matching finding, as one sentence a person (and the "ask why"
 * explainer, which answers only from recorded claims) can read: which line, which numbers, which
 * threshold, and where that put this invoice. Recorded next to the finding's code on the match
 * step, so "EXC-PRICE_VAR: block" says what was over and by how much.
 *
 * Each finding is also recorded as a short plain title and its figures side by side (`...Shown`):
 * what the invoice says, what the order, the delivery or your records say, and the gap, marked as
 * the part that is wrong. The screens show those as points; the sentence stays for the trail.
 *
 * Pure wording over numbers match-stage.ts already computed: nothing here decides anything. The
 * thresholds quoted are the ones decision-matrix.ts applies; each sentence ends with the route
 * the engine actually chose (passed in), never one recomputed here.
 */

/** A finding's sentence and its figures, built from the same numbers. */
export interface Fact { text: string; shown: FactShown }

const point = (source: FactPoint["source"], label: string, value: string, wrong = false): FactPoint =>
  (wrong ? { source, label, value, wrong } : { source, label, value });

const fact = <P>(text: (p: P) => string, shown: (p: P) => FactShown) => (p: P): Fact => ({ text: text(p), shown: shown(p) });

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
  /** The tax code's name, e.g. "18% GST, as printed on the invoice". */
  codeName?: string | null;
}): string {
  const expects = p.codeName ? `the ${pct(p.expectedRate)} of its tax code (${p.codeName})` : `the ${pct(p.expectedRate)} its tax code expects`;
  return `Line ${quote(p.description)}: tax charged ${money(p.charged, p.currency)} (${pct(p.actualRate)} of the line) against ${expects} (${money(p.expectedTax, p.currency)}). ` +
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
      : `${money(-p.net, p.currency)} of the credit is more than is open on that invoice, so a person decides it. If it is approved, that part comes off the vendor's next approved invoices. ${outcome(p.action)}`);
}

export function bankChangeFact(p: {
  status: string; action: Action;
  /** Last 4 digits of the account before and after the change, when known. */
  oldLast4?: string | null; newLast4?: string | null;
  /** The new account was read off this invoice (lib/bills.ts records it at intake). */
  fromThisInvoice?: boolean;
}): string {
  const accounts = p.oldLast4 && p.newLast4 ? ` from an account ending ${p.oldLast4} to one ending ${p.newLast4}${p.fromThisInvoice ? " (printed on this invoice)" : ""}` : "";
  return `The vendor's bank account details changed${accounts} and the change is not yet verified (review status: ${p.status}). ` +
    `Until someone phones the vendor on a number from your own records and a second person signs off, nothing is paid to this vendor. ${outcome(p.action)}`;
}

export function cleanMatchFact(p: { poNumber: string; matchedLines: number; currency: string; invoiced: number }): string {
  return `All ${p.matchedLines} invoice line${p.matchedLines === 1 ? "" : "s"} matched lines on purchase order ${p.poNumber}: every price is within 2% of the order, nothing is billed beyond what was received in good condition, and no line is outside the order. ` +
    `${money(p.invoiced, p.currency)} billed with no exception found.`;
}

// ------------------------------------------------------------------------------------------------ figures, side by side

const pctAbs = (x: number) => pct(Math.abs(x));
/** " each" for a count, " per box" for any other unit, "" for none. */
const per = (uom: string) => (!uom ? "" : uom === "each" ? " each" : ` per ${uom}`);

function priceVarianceShown(p: Parameters<typeof priceVarianceFact>[0]): FactShown {
  const over = p.billedPrice > p.poPrice;
  return {
    title: over ? "Charged more than the agreed price" : "Charged less than the agreed price",
    points: [
      point("invoice", `Price on the invoice for ${quote(p.description)}`, `${money(p.billedPrice, p.currency)}${per(p.uom)}`, true),
      point("order", `Agreed on the purchase order (line ${p.lineNumber})`, `${money(p.poPrice, p.currency)}${per(p.uom)}`),
      point("difference", over ? "Overcharged" : "Undercharged",
        `${money(p.billedPrice - p.poPrice, p.currency)} ${over ? "more" : "less"}${per(p.uom)} (${pctAbs(p.variancePct)}), ${money(p.impact, p.currency)} in total`, true),
      point("rule", "Allowed", `Up to 2% either way. 5% or more, or more than ${p.currency} 500, is blocked.`),
    ],
  };
}

function quantityVarianceShown(p: Parameters<typeof quantityVarianceFact>[0]): FactShown {
  return {
    title: "Billed for more than was delivered",
    points: [
      point("invoice", `Billed for ${quote(p.description)}`, `${qty(p.billedNow)} ${p.uom}`, true),
      point("order", `Ordered on the purchase order (line ${p.lineNumber})`, `${qty(p.ordered)} ${p.uom}`),
      point("receipt", "Delivered in good condition", `${qty(p.acceptedReceived)} ${p.uom}`),
      ...(p.billedBefore > 0 ? [point("records", "Already billed on earlier invoices", `${qty(p.billedBefore)} ${p.uom}`)] : []),
      point("difference", "Billed but not delivered", `${qty(p.excess)} ${p.uom}, worth ${money(p.impact, p.currency)} at the agreed price`, true),
      point("rule", "Allowed", "Nothing beyond what arrived. More than 5% or more than 2 units over is blocked; less goes to a reviewer."),
    ],
  };
}

function unmatchedLinesShown(p: Parameters<typeof unmatchedLinesFact>[0]): FactShown {
  const listed = p.lines.slice(0, 5);
  return {
    title: p.lines.length === 1 ? "Billed for something that was not ordered" : "Billed for things that were not ordered",
    points: [
      ...listed.map((l) => point("invoice", `On the invoice: ${quote(l.description)}`, `${qty(l.qty)} x ${money(l.unitPrice, p.currency)} = ${money(l.amount, p.currency)}`, true)),
      ...(p.lines.length > listed.length ? [point("invoice", "And more", `${p.lines.length - listed.length} more line(s) not on the order`, true)] : []),
      point("order", `On purchase order ${p.poNumber}`, p.lines.length === 1 ? "Not on the order at all" : "None of these are on the order"),
      point("difference", "Billed for things nobody ordered", money(p.total, p.currency), true),
      point("rule", "Allowed", `Never approved on its own. Up to ${p.currency} 1,000 a reviewer decides, up to 10,000 a reviewer at level 2, above that it is blocked.`),
    ],
  };
}

function uomMismatchShown(p: Parameters<typeof uomMismatchFact>[0]): FactShown {
  return {
    title: "Billed in a different unit than ordered",
    points: [
      point("invoice", `On the invoice: ${quote(p.invoiceDescription)}`, `billed per ${p.invoiceUom}`, true),
      point("order", `On the purchase order (line ${p.poLineNumber}): ${quote(p.poDescription)}`, `ordered per ${p.poUom}`),
      point("records", `How many ${p.invoiceUom} make one ${p.poUom}`, "Not on file for this vendor", true),
      point("rule", "So", p.plausible ? "The units measure the same kind of thing: a reviewer decides whether they match." : "The units measure different things, so the quantities cannot be compared."),
    ],
  };
}

function taxVarianceShown(p: Parameters<typeof taxVarianceFact>[0]): FactShown {
  const over = p.charged > p.expectedTax;
  return {
    title: over ? "Charged more tax than the rate allows" : "Charged less tax than the rate",
    points: [
      point("invoice", `Tax charged on ${quote(p.description)}`, `${money(p.charged, p.currency)} (${pct(p.actualRate)})`, true),
      p.codeName?.includes("printed on the invoice")
        ? point("invoice", `At the printed ${pct(p.expectedRate)} rate`, money(p.expectedTax, p.currency))
        : point("records", `Tax at ${pct(p.expectedRate)}${p.codeName ? ` (${p.codeName})` : ""}`, money(p.expectedTax, p.currency)),
      point("difference", over ? "Too much tax" : "Too little tax", money(p.charged - p.expectedTax, p.currency), true),
      point("rule", "Allowed", `More than 2 points of rate, or more than ${p.currency} 100 of tax, is blocked; less goes to a reviewer.`),
    ],
  };
}

function blanketValueShown(p: Parameters<typeof blanketValueFact>[0]): FactShown {
  const total = p.prior + p.current;
  return {
    title: "Spending limit on the order exceeded",
    points: [
      point("order", `Spending limit on ${p.poNumber}`, money(p.ceiling, p.currency)),
      ...(p.prior > 0 ? [point("records", "Already billed on earlier invoices", money(p.prior, p.currency))] : []),
      point("invoice", "This invoice", money(p.current, p.currency)),
      point("difference", "Over the limit", `${money(total - p.ceiling, p.currency)} (${pct((total - p.ceiling) / p.ceiling)}), with ${money(total, p.currency)} billed in all`, true),
      point("rule", "Allowed", "Up to 10% over, a reviewer decides at level 2; more than 10% is blocked."),
    ],
  };
}

function blanketQtyShown(p: Parameters<typeof blanketQtyFact>[0]): FactShown {
  const total = p.prior + p.current;
  return {
    title: "Quantity limit on the order exceeded",
    points: [
      point("order", `Quantity limit on ${p.poNumber}`, `${qty(p.ceiling)} units`),
      ...(p.prior > 0 ? [point("records", "Already billed on earlier invoices", `${qty(p.prior)} units`)] : []),
      point("invoice", "This invoice", `${qty(p.current)} units`),
      point("difference", "Over the limit", `${qty(total - p.ceiling)} units (${pct((total - p.ceiling) / p.ceiling)})`, true),
      point("rule", "Allowed", "Up to 10% over, a reviewer decides at level 2; more than 10% is blocked."),
    ],
  };
}

function beforeReceiptShown(p: Parameters<typeof beforeReceiptFact>[0]): FactShown {
  if (!p.earliestReceipt) {
    return {
      title: "Billed before any delivery was recorded",
      points: [
        point("invoice", "Invoice date", p.invoiceDate),
        point("receipt", `Deliveries recorded against ${p.poNumber}`, "None yet", true),
        point("rule", "So", "Record the delivery on the Orders page and the invoice is checked again on its own."),
      ],
    };
  }
  return {
    title: "Billed well before the goods arrived",
    points: [
      point("invoice", "Invoice date", p.invoiceDate, true),
      point("receipt", `First delivery against ${p.poNumber}`, p.earliestReceipt),
      point("difference", "Billed early by", `${p.gapDays} days`, true),
      point("rule", "Allowed", "Up to 7 days before delivery."),
    ],
  };
}

function currencyShown(p: Parameters<typeof currencyFact>[0]): FactShown {
  if (p.billCurrency !== p.poCurrency) {
    return {
      title: "Invoice and order are in different currencies",
      points: [
        point("invoice", "Currency on the invoice", p.billCurrency, true),
        point("order", `Currency of ${p.poNumber}`, p.poCurrency),
        point("rule", "So", "This system does not convert between currencies, so the amounts cannot be compared."),
      ],
    };
  }
  return {
    title: "Exchange rate differs from the order",
    points: [
      point("invoice", "Exchange rate on the invoice", String(p.billRate), true),
      point("order", `Exchange rate on ${p.poNumber}`, String(p.poRate)),
      point("difference", "Apart by", pct(p.ratePct), true),
      point("rule", "Allowed", "More than 1% apart goes to a reviewer at level 2, otherwise to a reviewer."),
    ],
  };
}

function nonPoShown(p: Parameters<typeof nonPoFact>[0]): FactShown {
  return {
    title: p.printedPoReference ? "Cites a purchase order that is not on file" : "No purchase order",
    points: [
      point("invoice", "Purchase order on the invoice", p.printedPoReference ?? "None", !p.printedPoReference),
      ...(p.printedPoReference ? [point("records", "Orders on file for this vendor", `No ${p.printedPoReference}`, true)] : []),
      point("invoice", "Amount", money(p.amount, p.currency)),
      point("records", "Vendor", p.trustTier === "trusted" ? "Trusted" : p.trustTier === "flagged" ? "Flagged" : "New (gets extra checks)"),
      point("rule", "Allowed without an order", `Only up to ${p.currency} 100 from a trusted vendor goes through on its own. Up to 1,000 a reviewer decides, up to 10,000 a reviewer at level 2, above that it is blocked.`),
    ],
  };
}

function noPoShown(p: Parameters<typeof noPoFact>[0]): FactShown {
  return {
    title: p.poStatus === "not_found" ? "Billed against an order that does not exist" : "Billed against a closed order",
    points: [
      point("invoice", "Purchase order on the invoice", p.poReference),
      point("records", "That order", p.poStatus === "not_found" ? "Not on file" : p.poStatus, true),
      point("rule", "So", "A missing or closed order cannot be billed against."),
    ],
  };
}

function creditMemoShown(p: Parameters<typeof creditMemoFact>[0]): FactShown {
  const target = p.relatedNumber ? `Invoice ${p.relatedNumber}` : "The invoice it is for";
  if (p.relatedStatus === "void") {
    return {
      title: "Credit against an invoice that was rejected",
      points: [
        point("invoice", "Credit on this document", money(p.credit, p.currency)),
        point("records", target, "Rejected: nothing was ever owed on it", true),
        point("rule", "So", "A person decides whether to take the credit."),
      ],
    };
  }
  const open = p.relatedStatus === "paid" ? "Already paid: nothing open" : `${money(p.openAmount, p.currency)} still open`;
  return {
    title: p.net >= 0 ? "Credit fits inside what is still owed" : "Credit is more than is still owed on its invoice",
    points: [
      point("invoice", "Credit on this document", money(p.credit, p.currency), p.net < 0),
      point("records", target, open),
      ...(p.net < 0
        ? [point("difference", "More than is open", money(-p.net, p.currency), true),
          point("rule", "So", "A person decides. If approved, the extra comes off the vendor's next approved invoices.")]
        : [point("difference", "Left open after the credit", money(p.net, p.currency))]),
    ],
  };
}

function bankChangeShown(p: Parameters<typeof bankChangeFact>[0]): FactShown {
  const callback: Record<string, string> = {
    flagged: "Not yet", callback_pending: "Not yet", callback_confirmed: "Confirmed, waiting for a second person", callback_failed: "The vendor did not confirm it",
  };
  return {
    title: "The vendor's bank account changed",
    points: [
      ...(p.oldLast4 ? [point("records", "Account on file before", `ending ${p.oldLast4}`)] : []),
      ...(p.newLast4 ? [point(p.fromThisInvoice ? "invoice" : "records", p.fromThisInvoice ? "Account on this invoice" : "New account", `ending ${p.newLast4}`, true)] : []),
      point("records", "Confirmed by phone", callback[p.status] ?? p.status, p.status !== "callback_confirmed"),
      point("rule", "So", "Nothing is paid until someone phones the vendor on a number from your own records and a second person signs off."),
    ],
  };
}

/** The sentence and the figures together, for match-stage.ts to record. */
export const priceVariance = fact(priceVarianceFact, priceVarianceShown);
export const quantityVariance = fact(quantityVarianceFact, quantityVarianceShown);
export const unmatchedLines = fact(unmatchedLinesFact, unmatchedLinesShown);
export const uomMismatch = fact(uomMismatchFact, uomMismatchShown);
export const taxVariance = fact(taxVarianceFact, taxVarianceShown);
export const blanketValue = fact(blanketValueFact, blanketValueShown);
export const blanketQty = fact(blanketQtyFact, blanketQtyShown);
export const beforeReceipt = fact(beforeReceiptFact, beforeReceiptShown);
export const currencyMismatch = fact(currencyFact, currencyShown);
export const nonPo = fact(nonPoFact, nonPoShown);
export const noPo = fact(noPoFact, noPoShown);
export const creditMemo = fact(creditMemoFact, creditMemoShown);
export const bankChange = fact(bankChangeFact, bankChangeShown);
