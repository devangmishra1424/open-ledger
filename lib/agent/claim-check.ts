import type { Claim } from "@/lib/types";

/**
 * What an AI step's record says, checked before it goes on the trail:
 *  - when a person challenged the decision, the AI's direct answer to their question comes first, or the record
 *    says plainly that the question went unanswered;
 *  - every figure in the AI's prose is looked up in the records it was given (the match result, its tool results,
 *    the Investigator's submission). A figure that is not there is listed under the explanation as unchecked: in a
 *    live test a Verifier wrote "300 units of gloves" (2,000 were billed) and "621 x 1.91 = 1186", and the trail
 *    showed them as fact.
 * Pure: the caller passes everything in.
 */

/** A number as written in prose: not part of an identifier (INV-2288, PO-NL-88213, 200uL) or a date (2026-10-20). */
const PROSE_NUMBER = /(?<![\w\-/.])\d[\d,]*(?:\.\d+)?(?![\w\-/]|\.\d)/g;
const EVIDENCE_NUMBER = /-?\d+(?:\.\d+)?/g;

const parse = (s: string) => Number(s.replace(/,/g, ""));

/** Every number in the evidence, plus the same value as a percentage or a fraction (0.0825 <-> 8.25%). */
function evidenceValues(evidence: unknown): number[] {
  const text = typeof evidence === "string" ? evidence : JSON.stringify(evidence ?? null);
  const out: number[] = [];
  for (const m of text.replace(/(\d),(\d{2,3})/g, "$1$2").matchAll(EVIDENCE_NUMBER)) {
    const n = Math.abs(Number(m[0]));
    if (Number.isFinite(n)) out.push(n, n * 100, n / 100);
  }
  return out;
}

/** Figures in `text` that appear nowhere in `evidence` (within rounding). Small counts and years are not checked. */
export function uncheckedFigures(text: string, evidence: unknown): string[] {
  const values = evidenceValues(evidence);
  const found = values.length > 0 ? values : [];
  const out: string[] = [];
  for (const m of text.matchAll(PROSE_NUMBER)) {
    const raw = m[0].replace(/[.,]+$/, "");
    const n = parse(raw);
    if (!Number.isFinite(n)) continue;
    if (Number.isInteger(n) && n < 10) continue; // "3 lines", "2 receipts": counts, not figures from a record
    if (Number.isInteger(n) && n >= 1990 && n <= 2100) continue; // a year
    const tolerance = Math.max(0.011, Math.abs(n) * 0.005); // rounding: 9.1% for 9.0989%, 1,186 for 1,186.4
    if (!found.some((v) => Math.abs(v - n) <= tolerance) && !out.includes(raw)) out.push(raw);
  }
  return out;
}

/** The claims an AI step records: the answer to a person's challenge (if any), its explanation, and any unchecked figures. */
export function aiClaims(p: {
  text: string;
  evidence: unknown;
  /** The person's challenge, when this run is a reconsideration they asked for. */
  challenge?: { by: string; question: string } | null;
  answer?: string | null;
}): Claim[] {
  const claims: Claim[] = [];
  if (p.challenge) {
    const answer = p.answer?.trim();
    claims.push(answer
      ? { text: `Answer to ${p.challenge.by}: ${answer}`, tag: uncheckedFigures(answer, p.evidence).length === 0 ? "grounded" : "ungrounded" }
      : { text: `${p.challenge.by}'s question was not answered by the AI: "${p.challenge.question}"`, tag: "ungrounded" });
  }
  const unchecked = uncheckedFigures([p.answer ?? "", p.text].join(" "), p.evidence);
  claims.push({ text: p.text, tag: unchecked.length === 0 ? "grounded" : "ungrounded" });
  if (unchecked.length > 0) {
    claims.push({
      text: `Figures in this AI explanation that are not in the records it was given (its own arithmetic or a misreading; unchecked): ${unchecked.slice(0, 12).join(", ")}.`,
      tag: "ungrounded",
    });
  }
  return claims;
}
