import { getDecisionsForInvoice } from "@/lib/ledger/decisions";
import { getLlmClient, modelFor, reasoningEffortFor, explainLlmError } from "@/lib/agent/llm";
import type { Decision } from "@/lib/types";

/**
 * The "ask why" mechanic (ENGINE.md §6a, DESIGN.md §8) — fast, grounded, no new agent
 * invocation. A sibling of lib/pipeline/, not inside it: used by BOTH the normal invoice
 * swimlane (this file, called directly) AND workflow #6's audit extension
 * (lib/audit/narrator.ts, a thin wrapper calling this same function with a pbc scope —
 * BUILD.md's own description of it).
 *
 * Retrieval-then-constrained-answer, per DESIGN.md §8:
 *   Stage A — pick the candidate decisions. Today that is ALL of the invoice's decisions
 *   (a normal pipeline pass writes ~6-8, so they fit in one prompt); DESIGN.md's embedding
 *   similarity ranking is deliberately not used until an invoice's trail outgrows a prompt.
 *   Stage B — answer using ONLY those records as context, every claim cited, an explicit
 *   "not recorded" fallback rather than invented inference. `grounded` is true only if the
 *   answer quotes at least one real decision id from the records it was given.
 */

const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 4; // transient 429/5xx only, with backoff (see lib/agent/loop.ts)

export interface ExplainResult {
  answer: string;
  citedDecisionIds: string[];
  grounded: boolean;
}

/**
 * Which of `ids` the answer quotes in full. Models sometimes write the hyphens of an id as non-breaking or other Unicode
 * hyphens (U+2011 seen in a live answer), which made a correctly cited answer count as "not grounded"; compare on plain ones.
 */
export function citedIds(answer: string, ids: string[]): string[] {
  const plain = answer.replace(/[\u2010-\u2015\u2212]/g, "-");
  return ids.filter((id) => plain.includes(id));
}

async function findCandidateDecisions(question: string, decisions: Decision[]): Promise<Decision[]> {
  // See the Stage A note above: all of the invoice's decisions, no ranking.
  return decisions;
}

/** Pulls in parents/children/reconsideration links for the candidate set (DESIGN.md §8: "plus linked parents/children"). */
function includeLinked(initialSet: Decision[], allDecisions: Decision[]): Decision[] {
  const finalSet = new Map<string, Decision>();
  const allById = new Map(allDecisions.map((d) => [d.id, d]));

  for (const d of initialSet) {
    if (!d) continue;
    finalSet.set(d.id, d);
    
    if (d.supersededById) {
      const superseding = allById.get(d.supersededById);
      if (superseding) finalSet.set(superseding.id, superseding);
    }
    if (d.reconsiderationOfId) {
      const original = allById.get(d.reconsiderationOfId);
      if (original) finalSet.set(original.id, original);
    }
  }

  return Array.from(finalSet.values());
}

const EXPLAIN_INSTRUCTIONS = `You answer questions about why an automated accounts-payable decision was made, using ONLY the decision records provided below as your evidence — never invent or infer beyond them. Be brief: 2-4 sentences total, not a report — a human is waiting on screen for this answer. Every claim must still cite the specific decision id it comes from, quoting each decision_id EXACTLY and IN FULL as given in the records — never shorten, truncate, or abbreviate it (no "abc123..."), e.g. "(see decision <full-decision_id>)". Do not restate every record or add a closing summary paragraph. Use contrastive framing where it fits: "held rather than auto-approved, because X; would have cleared if Y." If the question asks about something not captured in these records, say plainly that it wasn't recorded, rather than guessing. When you say what can happen next, name only what a person can do in this system: approve, reject, challenge it for an AI re-review, record goods received or add the purchase order on the Orders page, or retry the AI review. Never suggest contacting the vendor, requesting documents, or sending it to a team, and if a record contains advice like that, do not repeat it as a step to take.`;

/**
 * `decisionId` anchors the question to a specific node the human was looking at when they
 * asked "why" — always included in context even if Stage A's relevance score wouldn't have
 * surfaced it on its own.
 */
export async function explain(invoiceId: string, decisionId: string, question: string): Promise<ExplainResult> {
  const allDecisions = await getDecisionsForInvoice(invoiceId);
  const anchor = allDecisions.find((d) => d.id === decisionId);
  if (!anchor) throw new Error(`explain: decision '${decisionId}' not found for invoice '${invoiceId}'`);

  const candidates = await findCandidateDecisions(question, allDecisions);
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

  const model = modelFor("explainer");
  let response;
  try {
    response = await getLlmClient().chat.completions.create(
      {
        model,
        messages: [
          { role: "system", content: EXPLAIN_INSTRUCTIONS },
          { role: "user", content: JSON.stringify({ question, decisions: contextPayload }) },
        ],
        max_tokens: 4000,
        ...(reasoningEffortFor(model) ? { reasoning_effort: reasoningEffortFor(model) } : {}),
      },
      { timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES },
    );
  } catch (e) {
    throw explainLlmError(e, "explainer", model);
  }

  const answer = response.choices[0]?.message?.content?.trim() || "";
  
  const citedDecisionIds = citedIds(answer, context.map((d) => d.id));
  const grounded = citedDecisionIds.length > 0;

  return { answer, citedDecisionIds, grounded };
}
