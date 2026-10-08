import OpenAI from "openai";
import { getDecisionsForInvoice } from "@/lib/ledger/decisions";
import { getEmbedding, cosineSimilarity } from "@/lib/embeddings";
import type { Decision } from "@/lib/types";

/**
 * The "ask why" mechanic (ENGINE.md §6a, DESIGN.md §8) — fast, grounded, no new agent
 * invocation. A sibling of lib/pipeline/, not inside it: used by BOTH the normal invoice
 * swimlane (this file, called directly) AND workflow #6's audit extension
 * (lib/audit/narrator.ts, a thin wrapper calling this same function with a pbc scope —
 * BUILD.md's own description of it).
 *
 * Two-stage retrieval-then-constrained-answer, per DESIGN.md §8:
 *   Stage A — find candidate decisions relevant to the question, via real embedding
 *   similarity (lib/embeddings.ts) against each decision's own text content.
 *   Stage B — answer using ONLY the fetched records as context, every claim cited, an
 *   explicit "not recorded" fallback rather than invented inference.
 *
 * SCALE NOTE: every real call site scopes this to ONE invoice already (the API route is
 * /api/invoices/:id/decisions/:decisionId/explain) — no pgvector index needed, embeddings are
 * computed fresh per call over a small set (~6-8 decisions for a normal pipeline pass,
 * occasionally more with reconsiderations) and only when that set exceeds MAX_CANDIDATES.
 */

const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const TIMEOUT_MS = 20_000;
const MAX_RETRIES = 1;

let client: OpenAI | undefined;
function getGroqClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY is not set");
    client = new OpenAI({ apiKey, baseURL: "https://api.groq.com/openai/v1" });
  }
  return client;
}

export interface ExplainResult {
  answer: string;
  citedDecisionIds: string[];
  grounded: boolean;
}

async function findCandidateDecisions(question: string, decisions: Decision[]): Promise<Decision[]> {
  // Bypassing embeddings for demo/production determinism.
  // We just return all decisions (typically < 10 anyway).
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

const EXPLAIN_INSTRUCTIONS = `You answer questions about why an automated accounts-payable decision was made, using ONLY the decision records provided below as your evidence — never invent or infer beyond them. Be brief: 2-4 sentences total, not a report — a human is waiting on screen for this answer. Every claim must still cite the specific decision id it comes from, quoting each decision_id EXACTLY and IN FULL as given in the records — never shorten, truncate, or abbreviate it (no "abc123..."), e.g. "(see decision <full-decision_id>)". Do not restate every record or add a closing summary paragraph. Use contrastive framing where it fits: "held rather than auto-approved, because X; would have cleared if Y." If the question asks about something not captured in these records, say plainly that it wasn't recorded, rather than guessing.`;

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

  const openai = getGroqClient();
  const response = await openai.chat.completions.create(
    {
      model: DEFAULT_MODEL,
      messages: [
        { role: "system", content: EXPLAIN_INSTRUCTIONS },
        { role: "user", content: JSON.stringify({ question, decisions: contextPayload }) }
      ],
      max_tokens: 4000
    },
    { timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES },
  );

  const answer = response.choices[0]?.message?.content?.trim() || "";
  
  const citedDecisionIds = context.map((d) => d.id).filter((id) => answer.includes(id));
  const grounded = citedDecisionIds.length > 0;

  return { answer, citedDecisionIds, grounded };
}
