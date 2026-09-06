import OpenAI from "openai";
import { getDecisionsForInvoice } from "@/lib/ledger/decisions";
import { descriptionSimilarity } from "@/lib/matching/line-match";
import type { Decision } from "@/lib/types";

/**
 * The "ask why" mechanic (ENGINE.md §6a, DESIGN.md §8) — fast, grounded, no new agent
 * invocation. A sibling of lib/pipeline/, not inside it: used by BOTH the normal invoice
 * swimlane (this file, called directly) AND workflow #6's audit extension
 * (lib/audit/narrator.ts, a thin wrapper calling this same function with a pbc scope —
 * BUILD.md's own description of it).
 *
 * Two-stage retrieval-then-constrained-answer, per DESIGN.md §8:
 *   Stage A — find candidate decisions relevant to the question.
 *   Stage B — answer using ONLY the fetched records as context, every claim cited, an
 *   explicit "not recorded" fallback rather than invented inference.
 *
 * HONEST GAP: DESIGN.md §8 specifies Stage A as a fuzzy EMBEDDING search over `decisions`.
 * No embeddings/pgvector infrastructure exists in this codebase (same real gap as
 * lib/agent/tools.ts's check_duplicate near-duplicate detection, documented there for the
 * same reason). Since every real call site scopes this to ONE invoice already (the API route
 * is /api/invoices/:id/decisions/:decisionId/explain), and one invoice's decision count is
 * small (~6-8 for a normal pipeline pass, occasionally more with reconsiderations), Stage A
 * here is a deterministic trigram-Jaccard relevance score (reusing line-match.ts's own
 * descriptionSimilarity) rather than a real embedding search — correct for this codebase's
 * actual scale, not a silent shortcut on a large corpus.
 */

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-5-nano";
const TIMEOUT_MS = 20_000;
const MAX_RETRIES = 1;

let client: OpenAI | undefined;
function getOpenAiClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
    client = new OpenAI({ apiKey });
  }
  return client;
}

export interface ExplainResult {
  answer: string;
  citedDecisionIds: string[];
  grounded: boolean;
}

const MAX_CANDIDATES = 10;

/** Stage A — see the module doc's honest gap note on why this isn't a real embedding search. */
function findCandidateDecisions(question: string, decisions: Decision[]): Decision[] {
  if (decisions.length <= MAX_CANDIDATES) return decisions;
  const scored = decisions.map((d) => {
    const text = [d.nodeId, d.actionTaken, d.reasonCode, ...(d.claims?.map((c) => c.text) ?? [])].filter(Boolean).join(" ");
    return { d, score: descriptionSimilarity(question, text) };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES)
    .map((s) => s.d);
}

/** Pulls in parents/children/reconsideration links for the candidate set (DESIGN.md §8: "plus linked parents/children"). */
function includeLinked(seed: Decision[], allDecisions: Decision[]): Decision[] {
  const ids = new Set(seed.map((d) => d.id));
  for (const d of seed) {
    if (d.parentDecisionId) ids.add(d.parentDecisionId);
    if (d.reconsiderationOfId) ids.add(d.reconsiderationOfId);
  }
  for (const d of allDecisions) {
    if ((d.parentDecisionId && ids.has(d.parentDecisionId)) || (d.reconsiderationOfId && ids.has(d.reconsiderationOfId))) {
      ids.add(d.id);
    }
  }
  return allDecisions.filter((d) => ids.has(d.id));
}

const EXPLAIN_INSTRUCTIONS = `You answer questions about why an automated accounts-payable decision was made, using ONLY the decision records provided below as your evidence — never invent or infer beyond them. Every claim in your answer must cite the specific decision id it comes from, e.g. "(see decision abc-123)". Use contrastive framing where it fits: "held rather than auto-approved, because X; would have cleared if Y." If the question asks about something not captured in these records, say plainly that it wasn't recorded, rather than guessing.`;

/**
 * `decisionId` anchors the question to a specific node the human was looking at when they
 * asked "why" — always included in context even if Stage A's relevance score wouldn't have
 * surfaced it on its own.
 */
export async function explain(invoiceId: string, decisionId: string, question: string): Promise<ExplainResult> {
  const allDecisions = await getDecisionsForInvoice(invoiceId);
  const anchor = allDecisions.find((d) => d.id === decisionId);
  if (!anchor) throw new Error(`explain: decision '${decisionId}' not found for invoice '${invoiceId}'`);

  const candidates = findCandidateDecisions(question, allDecisions);
  const context = includeLinked([anchor, ...candidates], allDecisions);

  const contextPayload = context.map((d) => ({
    decision_id: d.id,
    node: d.nodeId,
    action_taken: d.actionTaken ?? null,
    reason_code: d.reasonCode ?? null,
    confidence: d.confidence ?? null,
    claims: d.claims?.map((c) => c.text) ?? [],
    superseded_by: d.supersededById ?? null,
    reconsideration_of: d.reconsiderationOfId ?? null,
    triggered_by_question: d.triggeredByQuestion ?? null,
  }));

  const openai = getOpenAiClient();
  const response = await openai.responses.create(
    { model: DEFAULT_MODEL, instructions: EXPLAIN_INSTRUCTIONS, input: JSON.stringify({ question, decisions: contextPayload }) },
    { timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES },
  );

  const answer = response.output_text;
  const citedDecisionIds = contextPayload.filter((d) => answer.includes(d.decision_id)).map((d) => d.decision_id);
  return { answer, citedDecisionIds, grounded: citedDecisionIds.length > 0 };
}
