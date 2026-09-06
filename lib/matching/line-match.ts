import computeMunkres from "munkres-js";
import {
  type Zone,
  classifyPriceVariance,
  classifyQuantityVariance,
  classifyLineAmountVariance,
} from "@/lib/matching/tolerance-zones";

/**
 * Line-level matching engine (docs/ap-three-way-match-spec.md §1.4.1, §1.7; ALGORITHMS.md §1).
 * Layer 1 — pure, deterministic, zero LLM involvement. Two passes:
 *
 * 1. `matchLinesGreedy` — primary key (stated PO line number) then fuzzy fallback
 *    (description similarity + UoM match). Cheap and handles the common case.
 * 2. `matchLinesHungarian` — runs ONLY on whatever the greedy pass couldn't place, doing
 *    optimal N:M assignment by aggregate line-amount cost. Handles split/consolidated
 *    invoices where line numbers don't correspond 1:1 (spec §1.7).
 *
 * This module takes clean structured input/output, not DB row shapes — it doesn't know
 * about `vendor_bill_lines.po_line_id` or persistence. The pipeline layer is responsible
 * for writing `matched[].poLineId` back onto the persisted invoice line.
 */

export interface InvoiceLineInput {
  id: string;
  description: string;
  uom: string;
  qty: number;
  unitPrice: number;
  /** The PO line number the invoice itself claims to reference, if extraction found one. */
  statedPoLineNumber?: number;
}

export interface PoLineInput {
  id: string;
  lineNumber: number;
  description: string;
  uom: string;
  qtyOrdered: number;
  unitPrice: number;
}

export type MatchMethod = "exact_line_number" | "fuzzy_description" | "hungarian";

export interface MatchedLine {
  invoiceLineId: string;
  poLineId: string;
  matchMethod: MatchMethod;
  priceVariance: { zone: Zone; variancePct: number };
  qtyVariance: { zone: Zone; variancePct: number; varianceUnits: number };
  lineAmountVariance: { zone: Zone; varianceAbs: number; variancePct: number };
}

export interface UnmatchedInvoiceLine {
  invoiceLineId: string;
}

export interface LineMatchReport {
  matched: MatchedLine[];
  unmatchedInvoiceLines: UnmatchedInvoiceLine[];
  unmatchedPoLines: PoLineInput[];
}

/**
 * Trigram Jaccard similarity — "a simple token-overlap or trigram Jaccard score is
 * sufficient at hackathon scale" (ALGORITHMS.md §1). Deliberately not an embedding call:
 * this is cheap string comparison, not semantic judgment reserved for Layer 2.
 */
function trigrams(s: string): Set<string> {
  const norm = s.toLowerCase().trim().replace(/\s+/g, " ");
  if (norm.length < 3) return new Set([norm]);
  const grams = new Set<string>();
  for (let i = 0; i <= norm.length - 3; i++) grams.add(norm.slice(i, i + 3));
  return grams;
}

export function descriptionSimilarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  let intersection = 0;
  for (const g of A) if (B.has(g)) intersection++;
  const union = A.size + B.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function classifyMatchedPair(invLine: InvoiceLineInput, poLine: PoLineInput, matchMethod: MatchMethod): MatchedLine {
  const invoiceLineAmount = invLine.unitPrice * invLine.qty;
  // Expected amount uses the PO's unit price at the INVOICED quantity, not the PO's ordered
  // quantity — this checks "did they bill the right price for what they billed", per spec §1.4.1 step 5.
  const expectedLineAmount = poLine.unitPrice * invLine.qty;
  return {
    invoiceLineId: invLine.id,
    poLineId: poLine.id,
    matchMethod,
    priceVariance: classifyPriceVariance(invLine.unitPrice, poLine.unitPrice),
    qtyVariance: classifyQuantityVariance(invLine.qty, poLine.qtyOrdered),
    lineAmountVariance: classifyLineAmountVariance(invoiceLineAmount, expectedLineAmount),
  };
}

export interface GreedyMatchResult {
  matched: MatchedLine[];
  unmatchedInvoiceLines: UnmatchedInvoiceLine[];
  remainingPoLines: PoLineInput[];
}

/** Primary pass: spec §1.4.1 steps 1-2 (exact line-number key, then fuzzy description+UoM fallback). */
export function matchLinesGreedy(invoiceLines: InvoiceLineInput[], poLines: PoLineInput[]): GreedyMatchResult {
  const remaining = [...poLines];
  const matched: MatchedLine[] = [];
  const unmatchedInvoiceLines: UnmatchedInvoiceLine[] = [];

  for (const invLine of invoiceLines) {
    let match: PoLineInput | undefined;
    let method: MatchMethod = "exact_line_number";

    if (invLine.statedPoLineNumber != null) {
      match = remaining.find((p) => p.lineNumber === invLine.statedPoLineNumber);
    }

    if (!match) {
      const candidates = remaining
        .filter((p) => p.uom === invLine.uom)
        .map((p) => ({ p, sim: descriptionSimilarity(p.description, invLine.description) }))
        .filter((c) => c.sim >= 0.85)
        .sort((a, b) => b.sim - a.sim);
      if (candidates.length > 0) {
        match = candidates[0].p;
        method = "fuzzy_description";
      }
    }

    if (match) {
      remaining.splice(remaining.indexOf(match), 1);
      matched.push(classifyMatchedPair(invLine, match, method));
    } else {
      unmatchedInvoiceLines.push({ invoiceLineId: invLine.id });
    }
  }

  return { matched, unmatchedInvoiceLines, remainingPoLines: remaining };
}

// Stand-in for "not matchable" (UoM-incompatible pair) in the Hungarian cost matrix. Using a
// large finite number rather than real Infinity: munkres-js's internal steps do direct
// row/column-minima subtraction on matrix cells, and Infinity - Infinity produces NaN there.
// Real invoice/PO line amounts are dollar figures nowhere near this magnitude, so any
// assignment forced onto a cell at this cost is exactly as infeasible as if it were Infinity.
const HUNGARIAN_DISALLOWED_COST = 1e12;

/**
 * spec §1.7: "N invoice lines → M PO lines" via Hungarian (min-cost) assignment. Only ever
 * called on what's left after the greedy pass (ALGORITHMS.md §1). munkres-js pads a
 * rectangular matrix and already excludes padded dummy rows/cols from its result — see
 * `Munkres.prototype.compute`'s `original_length`/`original_width` bound check — so a
 * genuinely unmatched line (more invoice lines than PO lines, or vice versa) naturally
 * produces no result entry, with no manual padding needed here.
 *
 * SCOPE NOTE: spec §1.7 actually lists three distinct scenarios — "1 invoice line → N PO
 * lines" (proportional split by quantity), "N invoice lines → 1 PO line" (sum and compare to
 * a single total), and "N invoice lines → M PO lines" (this Hungarian assignment). The first
 * two are combinatorial subset-matching problems, not bipartite assignment, and ALGORITHMS.md
 * §1's own pseudocode — the authoritative implementation spec for this file — only specifies
 * the third: pure 1:1 min-cost assignment as the practical hackathon-scope approximation for
 * all three. A line that would only resolve via literal amount-splitting or summing surfaces
 * here as unmatched, to be handled by the investigate stage (Layer 2), not silently combined.
 */
export function matchLinesHungarian(invoiceLines: InvoiceLineInput[], poLines: PoLineInput[]): LineMatchReport {
  if (invoiceLines.length === 0 || poLines.length === 0) {
    return {
      matched: [],
      unmatchedInvoiceLines: invoiceLines.map((l) => ({ invoiceLineId: l.id })),
      unmatchedPoLines: poLines,
    };
  }

  const costMatrix = invoiceLines.map((invLine) =>
    poLines.map((poLine) => {
      if (poLine.uom !== invLine.uom) return HUNGARIAN_DISALLOWED_COST;
      const invoiceLineAmount = invLine.unitPrice * invLine.qty;
      const poLineAmount = poLine.unitPrice * poLine.qtyOrdered;
      return Math.abs(invoiceLineAmount - poLineAmount);
    }),
  );

  const assignment = computeMunkres(costMatrix);
  const matchedInvIdx = new Set<number>();
  const matchedPoIdx = new Set<number>();
  const matched: MatchedLine[] = [];

  for (const [i, j] of assignment) {
    if (costMatrix[i][j] >= HUNGARIAN_DISALLOWED_COST) continue;
    matchedInvIdx.add(i);
    matchedPoIdx.add(j);
    matched.push(classifyMatchedPair(invoiceLines[i], poLines[j], "hungarian"));
  }

  return {
    matched,
    unmatchedInvoiceLines: invoiceLines.filter((_, i) => !matchedInvIdx.has(i)).map((l) => ({ invoiceLineId: l.id })),
    unmatchedPoLines: poLines.filter((_, j) => !matchedPoIdx.has(j)),
  };
}

/** Full two-pass pipeline: greedy first, then Hungarian on whatever's left (ALGORITHMS.md §1). */
export function matchLines(invoiceLines: InvoiceLineInput[], poLines: PoLineInput[]): LineMatchReport {
  const greedy = matchLinesGreedy(invoiceLines, poLines);
  const unmatchedIds = new Set(greedy.unmatchedInvoiceLines.map((u) => u.invoiceLineId));
  const stillUnmatchedInvoiceLines = invoiceLines.filter((l) => unmatchedIds.has(l.id));

  const hungarian = matchLinesHungarian(stillUnmatchedInvoiceLines, greedy.remainingPoLines);

  return {
    matched: [...greedy.matched, ...hungarian.matched],
    unmatchedInvoiceLines: hungarian.unmatchedInvoiceLines,
    unmatchedPoLines: hungarian.unmatchedPoLines,
  };
}
