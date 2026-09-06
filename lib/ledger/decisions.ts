import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { getSql } from "@/db/client";
import { computeHash } from "./hash-chain";
import type { Decision, NodeId } from "@/lib/types";

/**
 * The hash chain is GLOBAL across every decision ever written (one single append-only
 * ledger, not one per invoice) — this is what the dashboard's single "chain verified ✓"
 * indicator and /api/audit/verify check. Ordered by the `seq` BIGSERIAL column (Postgres
 * has no implicit rowid the way SQLite does, so this is an explicit monotonic sequence).
 * All functions here are async now that the database is a real network round-trip
 * (Supabase Postgres), not an in-process SQLite file.
 */

export interface WriteDecisionInput {
  invoiceId?: string;
  nodeId: NodeId;
  parentDecisionId?: string;
  reconsiderationOfId?: string;
  agentId: string;
  model?: string;
  modelVersion?: string;
  startedAt: string;
  endedAt?: string;
  inputsConsumed?: Decision["inputsConsumed"];
  toolCalls?: Decision["toolCalls"];
  claims?: Decision["claims"];
  policyEvaluation?: Decision["policyEvaluation"];
  confidence?: number;
  actionTaken?: string;
  reasonCode?: string;
  forwardedTo?: string;
  whatWasForwarded?: string;
  triggeredByActor?: string;
  triggeredByQuestion?: string;
  idempotencyKey?: string;
}

/**
 * The exact shape that gets hashed. Exported deliberately: anything that verifies a decision's
 * hash later (verifyChain(), /api/audit/verify) MUST call `hashableRow(fromRow(dbRow))` — i.e.
 * go through this same function on a reconstructed Decision object — never hash a raw DB row
 * directly. The raw row uses snake_case keys (prev_hash); this function's output uses
 * camelCase (prevHash). Hashing the wrong shape produces a different canonicalized string and
 * would make every decision falsely appear tampered — this is exactly the class of bug that
 * broke `superseded_by_id` earlier, caught the same way: trace the shapes by hand before
 * trusting them.
 */
export function hashableRow(d: Decision) {
  return {
    id: d.id,
    invoice_id: d.invoiceId ?? null,
    node_id: d.nodeId,
    parent_decision_id: d.parentDecisionId ?? null,
    reconsideration_of_id: d.reconsiderationOfId ?? null,
    superseded_by_id: d.supersededById ?? null, // excluded inside canonicalize() itself
    agent_id: d.agentId,
    model: d.model ?? null,
    model_version: d.modelVersion ?? null,
    started_at: d.startedAt,
    ended_at: d.endedAt ?? null,
    inputs_consumed: d.inputsConsumed ? JSON.stringify(d.inputsConsumed) : null,
    tool_calls: d.toolCalls ? JSON.stringify(d.toolCalls) : null,
    claims: d.claims ? JSON.stringify(d.claims) : null,
    policy_evaluation: d.policyEvaluation ? JSON.stringify(d.policyEvaluation) : null,
    confidence: d.confidence ?? null,
    action_taken: d.actionTaken ?? null,
    reason_code: d.reasonCode ?? null,
    forwarded_to: d.forwardedTo ?? null,
    what_was_forwarded: d.whatWasForwarded ?? null,
    triggered_by_actor: d.triggeredByActor ?? null,
    triggered_by_question: d.triggeredByQuestion ?? null,
    idempotency_key: d.idempotencyKey ?? null,
    prevHash: d.prevHash ?? null,
    created_at: d.createdAt,
  };
}

function fromRow(row: any): Decision {
  return {
    id: row.id,
    invoiceId: row.invoice_id ?? undefined,
    nodeId: row.node_id,
    parentDecisionId: row.parent_decision_id ?? undefined,
    reconsiderationOfId: row.reconsideration_of_id ?? undefined,
    supersededById: row.superseded_by_id ?? undefined,
    agentId: row.agent_id,
    model: row.model ?? undefined,
    modelVersion: row.model_version ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    inputsConsumed: row.inputs_consumed ? JSON.parse(row.inputs_consumed) : undefined,
    toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
    claims: row.claims ? JSON.parse(row.claims) : undefined,
    policyEvaluation: row.policy_evaluation ? JSON.parse(row.policy_evaluation) : undefined,
    confidence: row.confidence ?? undefined,
    actionTaken: row.action_taken ?? undefined,
    reasonCode: row.reason_code ?? undefined,
    forwardedTo: row.forwarded_to ?? undefined,
    whatWasForwarded: row.what_was_forwarded ?? undefined,
    triggeredByActor: row.triggered_by_actor ?? undefined,
    triggeredByQuestion: row.triggered_by_question ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    prevHash: row.prev_hash ?? undefined,
    hash: row.hash,
    createdAt: row.created_at,
  };
}

/**
 * A fixed, arbitrary key for the hash-chain's advisory lock — see the correctness note below.
 * Any stable int8 works; this one has no special meaning beyond being a constant.
 */
const HASH_CHAIN_LOCK_KEY = 9081726354;

/**
 * Append-only insert: writes the decision, chained to whatever the last global hash was.
 *
 * Correctness note, real not hypothetical: unlike SQLite (single-connection, serializes every
 * write automatically), Postgres genuinely allows concurrent connections — two writeDecision()
 * calls arriving at the same moment could both read the same "last hash," then both insert
 * claiming it as their prev_hash, silently forking the chain. This is exactly the risk ENGINE.md
 * §5 flagged as a future concern when this project was still on SQLite ("scaling to Postgres
 * would need a single-writer advisory lock around the hash-chain sequence") — now that we've
 * actually switched to Postgres (for live hosting), that future is now. Fixed here with a
 * transaction-scoped Postgres advisory lock (`pg_advisory_xact_lock`): it serializes the
 * read-last-hash + insert sequence globally, and auto-releases at commit/rollback — no manual
 * unlock to forget.
 */
export async function writeDecision(input: WriteDecisionInput): Promise<Decision> {
  const sql = getSql();

  if (input.idempotencyKey) {
    const existing = await sql`SELECT * FROM decisions WHERE idempotency_key = ${input.idempotencyKey}`;
    if (existing.length > 0) return fromRow(existing[0]); // already written — don't double-post (ENGINE.md §5)
  }

  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${HASH_CHAIN_LOCK_KEY})`;

    const last = await tx`SELECT hash FROM decisions ORDER BY seq DESC LIMIT 1`;
    const prevHash: string | null = last.length > 0 ? last[0].hash : null;

    const decision = await buildAndInsertDecision(tx, input, prevHash);
    return decision;
  });
}

async function buildAndInsertDecision(
  sql: TransactionSql<{}>,
  input: WriteDecisionInput,
  prevHash: string | null
): Promise<Decision> {
  const decision: Decision = {
    id: randomUUID(),
    invoiceId: input.invoiceId,
    nodeId: input.nodeId,
    parentDecisionId: input.parentDecisionId,
    reconsiderationOfId: input.reconsiderationOfId,
    agentId: input.agentId,
    model: input.model,
    modelVersion: input.modelVersion,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    inputsConsumed: input.inputsConsumed,
    toolCalls: input.toolCalls,
    claims: input.claims,
    policyEvaluation: input.policyEvaluation,
    confidence: input.confidence,
    actionTaken: input.actionTaken,
    reasonCode: input.reasonCode,
    forwardedTo: input.forwardedTo,
    whatWasForwarded: input.whatWasForwarded,
    triggeredByActor: input.triggeredByActor,
    triggeredByQuestion: input.triggeredByQuestion,
    idempotencyKey: input.idempotencyKey,
    prevHash: prevHash ?? undefined,
    hash: "", // computed below, then fixed
    createdAt: new Date().toISOString(),
  };
  decision.hash = computeHash(prevHash, hashableRow(decision));

  const r = hashableRow(decision);
  await sql`
    INSERT INTO decisions (id, invoice_id, node_id, parent_decision_id, reconsideration_of_id, superseded_by_id,
      agent_id, model, model_version, started_at, ended_at, inputs_consumed, tool_calls, claims, policy_evaluation,
      confidence, action_taken, reason_code, forwarded_to, what_was_forwarded, triggered_by_actor, triggered_by_question,
      idempotency_key, prev_hash, hash, created_at)
    VALUES (${r.id}, ${r.invoice_id}, ${r.node_id}, ${r.parent_decision_id}, ${r.reconsideration_of_id}, ${r.superseded_by_id},
      ${r.agent_id}, ${r.model}, ${r.model_version}, ${r.started_at}, ${r.ended_at}, ${r.inputs_consumed}, ${r.tool_calls}, ${r.claims}, ${r.policy_evaluation},
      ${r.confidence}, ${r.action_taken}, ${r.reason_code}, ${r.forwarded_to}, ${r.what_was_forwarded}, ${r.triggered_by_actor}, ${r.triggered_by_question},
      ${r.idempotency_key}, ${prevHash}, ${decision.hash}, ${r.created_at})
  `;

  return decision;
}

export async function getDecision(id: string): Promise<Decision | undefined> {
  const rows = await getSql()`SELECT * FROM decisions WHERE id = ${id}`;
  return rows.length > 0 ? fromRow(rows[0]) : undefined;
}

export async function getDecisionsForInvoice(invoiceId: string): Promise<Decision[]> {
  const rows = await getSql()`SELECT * FROM decisions WHERE invoice_id = ${invoiceId} ORDER BY seq ASC`;
  return rows.map(fromRow);
}

export async function getAllDecisionsInOrder(): Promise<Decision[]> {
  const rows = await getSql()`SELECT * FROM decisions ORDER BY seq ASC`;
  return rows.map(fromRow);
}

/** Decisions at the same invoice that came after `after` in the pipeline (used by the reconsider cascade). */
export async function getDecisionsAfter(after: Decision): Promise<Decision[]> {
  if (!after.invoiceId) return [];
  const sql = getSql();
  const rows = await sql`
    SELECT d.* FROM decisions d, decisions anchor
    WHERE anchor.id = ${after.id} AND d.invoice_id = ${after.invoiceId} AND d.seq > anchor.seq
    ORDER BY d.seq ASC
  `;
  return rows.map(fromRow);
}

export async function markSuperseded(decisionId: string, byId: string): Promise<void> {
  await getSql()`UPDATE decisions SET superseded_by_id = ${byId} WHERE id = ${decisionId} AND superseded_by_id IS NULL`;
  // The one deliberate exception to "never UPDATE a decisions row" — it only ever sets a
  // forward pointer once (the WHERE clause makes a second attempt a no-op), and it never
  // touches any of the row's actual decision content. hash-chain.ts's canonicalize()
  // explicitly excludes this field from the hashed payload for exactly this reason — see
  // the comment there and the regression test in tests/hash-chain.test.ts.
}

export async function countReconsiderations(originalDecisionId: string): Promise<number> {
  const rows = await getSql()`SELECT COUNT(*)::int as n FROM decisions WHERE reconsideration_of_id = ${originalDecisionId}`;
  return rows[0].n;
}
