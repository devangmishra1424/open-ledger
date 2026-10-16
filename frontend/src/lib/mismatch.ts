/**
 * Wording for what does not match on an invoice (the server's `mismatches`, lib/mismatches.ts): who says each
 * figure, and the short form a list row has room for. Pure, so it is tested on its own.
 */

export interface PointLike { source: 'invoice' | 'order' | 'receipt' | 'records' | 'difference' | 'rule'; label: string; value: string; wrong?: boolean }
export interface MismatchLike { code: string; title: string; points: PointLike[]; text: string | null; source: 'recorded' | 'worked_out' }

/** Who says it, as a chip next to each figure. */
export const SAYS: Record<PointLike['source'], string> = {
  invoice: 'Invoice',
  order: 'Purchase order',
  receipt: 'Delivery',
  records: 'Your records',
  difference: 'Gap',
  rule: 'Rule',
};

/** Short labels for a list row: the full label when it is short, otherwise who says it. */
const SHORT: Partial<Record<PointLike['source'], string>> = { invoice: 'Invoice', order: 'PO', receipt: 'Delivered' };

/** The one finding a list row leads with: the one behind the invoice's reason, else the first. */
export function mainMismatch(mismatches: MismatchLike[] | undefined, reasonCode: string | null | undefined): MismatchLike | null {
  if (!mismatches || mismatches.length === 0) return null;
  return mismatches.find((m) => m.code === reasonCode) ?? mismatches[0];
}

/**
 * Up to `max` figures for a list row, the gap always among them: "Invoice USD 17,710.00 per each · PO USD 15,400.00
 * per each · Overcharged USD 2,310.00 ...". Rules are left out: the row's route chip already says what happens.
 */
export function briefPoints(m: MismatchLike, max = 3): Array<{ label: string; value: string; wrong: boolean }> {
  const facts = m.points.filter((p) => p.source !== 'rule');
  const gap = facts.filter((p) => p.source === 'difference');
  // What the invoice says first, then what arrived, then the order, then your records: with room for only a few,
  // "billed 20, delivered 15" says more than "billed 20, ordered 20".
  const order: PointLike['source'][] = ['invoice', 'receipt', 'order', 'records'];
  const rest = facts.filter((p) => p.source !== 'difference')
    .map((p, i) => ({ p, i }))
    .sort((a, b) => order.indexOf(a.p.source) - order.indexOf(b.p.source) || a.i - b.i)
    .map((x) => x.p)
    .slice(0, Math.max(0, max - gap.length));
  return [...rest, ...gap].slice(0, max).map((p) => ({
    label: p.label.length <= 30 || !SHORT[p.source] ? p.label : SHORT[p.source]!,
    value: p.value,
    wrong: Boolean(p.wrong),
  }));
}
