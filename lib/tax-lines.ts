/**
 * The tax rate an invoice prints next to its tax ("CGST @ 9%" + "SGST @ 9%", "VAT 20%", "Sales Tax 8.25%"), and the
 * tax it charges spread over its lines by amount, so the match step's per-line tax check (EXC-TAX_VAR) can compare
 * what was charged with the rate the invoice itself states. Nothing is guessed: when a tax line prints no rate, or
 * an invoice-level discount makes the taxable amount unclear, there is nothing to compare and no check is set up.
 *
 * Pure. Checked against every sample invoice in eval/documents (each one's tax matches its printed rate).
 */

export interface StatedTax {
  /** The rates printed on the tax lines, added up (CGST 9% + SGST 9% = 0.18). */
  rate: number;
  type: "gst" | "vat" | "sales_tax";
  /** How the rate is named on the record: "18% GST, as printed on the invoice". */
  name: string;
}

const RATE = /(\d{1,2}(?:\.\d{1,3})?)\s*%/;
/** The same tolerance the tax check itself uses (tolerance-zones.ts: within half a percentage point is fine). */
const FITS = 0.005;

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The rate the invoice states for the tax it charges, or null when any tax line prints no rate. */
export function statedTaxRate(taxLines: Array<{ label: string; amount: number }>): StatedTax | null {
  const taxed = taxLines.filter((t) => t.amount > 0);
  if (taxed.length === 0) return null;
  let rate = 0;
  for (const t of taxed) {
    const m = RATE.exec(t.label);
    if (!m) return null;
    rate += Number(m[1]) / 100;
  }
  if (!(rate > 0 && rate < 1)) return null;
  rate = Math.round(rate * 1e6) / 1e6;
  const labels = taxed.map((t) => t.label).join(" ");
  const type: StatedTax["type"] = /gst/i.test(labels) ? "gst" : /vat/i.test(labels) ? "vat" : "sales_tax";
  const pct = Number((rate * 100).toFixed(3));
  return { rate, type, name: `${pct}% ${type === "sales_tax" ? "sales tax" : type.toUpperCase()}, as printed on the invoice` };
}

/**
 * Each line's share of the tax charged, in line order (items, then charges), or null when it cannot be spread
 * fairly. The taxable amount is the items alone, or items and charges, whichever the printed rate fits better (an
 * invoice that taxes its shipping is not flagged for it). When neither fits but an invoice-level discount would
 * explain the tax, the check is not set up: the per-line check could not see the discount and would cry wolf.
 * Shares are in cents; the last taxed line takes the rounding so the shares add up to what was charged.
 */
export function spreadTax(p: { charged: number; items: number[]; charges: number[]; discount: number; rate: number }): number[] | null {
  const items = sum(p.items);
  const all = items + sum(p.charges);
  if (!(p.charged > 0) || !(items > 0)) return null;
  const withCharges = p.charges.length > 0 && Math.abs(p.charged / all - p.rate) < Math.abs(p.charged / items - p.rate);
  const base = withCharges ? all : items;
  if (Math.abs(p.charged / base - p.rate) > FITS && p.discount > 0 && Math.abs(p.charged / (base - p.discount) - p.rate) <= FITS) return null;

  const amounts = [...p.items, ...p.charges.map((c) => (withCharges ? c : 0))];
  const shares = amounts.map((a) => round2((p.charged * a) / base));
  const lastTaxed = amounts.map((a) => a > 0).lastIndexOf(true);
  if (lastTaxed >= 0) shares[lastTaxed] = round2(shares[lastTaxed] + p.charged - sum(shares));
  return shares;
}
