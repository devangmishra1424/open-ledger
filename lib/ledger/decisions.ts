import { randomUUID } from "node:crypto";
import { getDb } from "@/db/client";
import { computeHash } from "./hash-chain";
import type { Decision, NodeId } from "@/lib/types";

/**
 * The hash chain is GLOBAL across every decision ever written (one single append-only
 * ledger, not one per invoice) — this is what the dashboard's single "chain verified ✓"
 * indicator and /api/audit/verify check. better-sqlite3 is synchronous/single-connection,
 * which serializes every write and makes this safe without extra locking (ENGINE.md §5).
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

function toRow(d: Decision) {
  return {
    id: d.id,
    invoice_id: d.invoiceId ?? null,
    node_id: d.nodeId,
    parent_decision_id: d.parentDecisionId ?? null,
    reconsideration_of_id: d.reconsiderationOfId ?? null,
    superseded_by_id: d.supersededById ?? null,
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
    prev_hash: d.prevHash ?? null,
    hash: d.hash,
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

/** Append-only insert: writes the decision, chained to whatever the last global hash was. */
export function writeDecision(input: WriteDecisionInput): Decision {
  const db = getDb();

  if (input.idempotencyKey) {
    const existing = db.prepare(`SELECT * FROM decisions WHERE idempotency_key = ?`).get(input.idempotencyKey);
    if (existing) return fromRow(existing); // already written — don't double-post (ENGINE.md §5)
  }

  const last = db.prepare(`SELECT hash FROM decisions ORDER BY rowid DESC LIMIT 1`).get() as { hash: string } | undefined;
  const prevHash = last?.hash ?? null;

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
  decision.hash = computeHash(prevHash, toRow(decision));

  db.prepare(
    `INSERT INTO decisions (id, invoice_id, node_id, parent_decision_id, reconsideration_of_id, superseded_by_id,
      agent_id, model, model_version, started_at, ended_at, inputs_consumed, tool_calls, claims, policy_evaluation,
      confidence, action_taken, reason_code, forwarded_to, what_was_forwarded, triggered_by_actor, triggered_by_question,
      idempotency_key, prev_hash, hash, created_at)
    VALUES (@id, @invoice_id, @node_id, @parent_decision_id, @reconsideration_of_id, @superseded_by_id,
      @agent_id, @model, @model_version, @started_at, @ended_at, @inputs_consumed, @tool_calls, @claims, @policy_evaluation,
      @confidence, @action_taken, @reason_code, @forwarded_to, @what_was_forwarded, @triggered_by_actor, @triggered_by_question,
      @idempotency_key, @prev_hash, @hash, @created_at)`
  ).run(toRow(decision));

  return decision;
}

export function getDecision(id: string): Decision | undefined {
  const row = getDb().prepare(`SELECT * FROM decisions WHERE id = ?`).get(id);
  return row ? fromRow(row) : undefined;
}

export function getDecisionsForInvoice(invoiceId: string): Decision[] {
  const rows = getDb().prepare(`SELECT * FROM decisions WHERE invoice_id = ? ORDER BY rowid ASC`).all(invoiceId);
  return rows.map(fromRow);
}

export function getAllDecisionsInOrder(): Decision[] {
  const rows = getDb().prepare(`SELECT * FROM decisions ORDER BY rowid ASC`).all();
  return rows.map(fromRow);
}

/** Decisions at the same invoice that came after `after` in the pipeline (used by the reconsider cascade). */
export function getDecisionsAfter(after: Decision): Decision[] {
  if (!after.invoiceId) return [];
  const rows = getDb()
    .prepare(`SELECT * FROM decisions WHERE invoice_id = ? AND rowid > (SELECT rowid FROM decisions WHERE id = ?) ORDER BY rowid ASC`)
    .all(after.invoiceId, after.id);
  return rows.map(fromRow);
}

export function markSuperseded(decisionId: string, byId: string): void {
  getDb().prepare(`UPDATE decisions SET superseded_by_id = ? WHERE id = ? AND superseded_by_id IS NULL`).run(byId, decisionId);
  // Note: this is the one deliberate exception to "never UPDATE a decisions row" — it only ever
  // sets a forward pointer once (the WHERE clause makes it a no-op on a second attempt), it never
  // touches any of the row's actual decision content (nodeId, actionTaken, hash, etc.), so the
  // hash chain's own integrity (computed over the content fields) is untouched by this update.
}

export function countReconsiderations(originalDecisionId: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) as n FROM decisions WHERE reconsideration_of_id = ?`)
    .get(originalDecisionId) as { n: number };
  return row.n;
}
