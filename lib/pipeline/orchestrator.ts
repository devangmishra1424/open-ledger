import crypto from "node:crypto";
import { getSql } from "@/db/client";
import { writeDecision } from "@/lib/ledger/decisions";
import { runPreMatchValidation, type PreMatchInput, type PreMatchResult } from "@/lib/matching/pre-match-validation";
import { runMatchStage, type MatchStageResult } from "@/lib/pipeline/match-stage";
import { moreRestrictive, parseRecommendedAction, type Action, type CombinedDecision } from "@/lib/matching/decision-matrix";
import { investigate, type InvestigationSubmission } from "@/lib/agent/investigator";
import { verify, type VerificationSubmission } from "@/lib/agent/verifier";
import { extract, type ExtractionResult } from "@/lib/agent/extractor";
import { modelFor } from "@/lib/agent/llm";
import { getPolicyLimits, guardrailBreach } from "@/lib/settings";
import { postBillApproval } from "@/lib/ledger/journal";
import { settleApprovedBill, settlementNote } from "@/lib/payments/payments";
import { notifyReviewer } from "@/lib/telegram";
import { hashJson } from "@/lib/agent/hash";
import { publishPipelineEvent } from "@/lib/pipeline/events";
import type { Decision, Claim } from "@/lib/types";
import type { HumanReconsiderationContext } from "@/lib/agent/investigator";

/**
 * Carried through investigate/verify/policy/audit when a stage is being (re-)invoked as part
 * of a reconsideration (lib/pipeline/reconsider.ts, ALGORITHMS.md §3) — either the node the
 * human directly asked to reconsider, or a downstream node re-run because that reconsideration
 * changed the outcome. `reconsiderationOfId` is only set on the DIRECTLY reconsidered node's
 * new decision row (matching the spec's own pseudocode); downstream cascade re-runs pass
 * `directlyReconsidered: false` so they get a fresh idempotency key without falsely claiming
 * to BE the reconsideration of that original decision themselves.
 */
export interface ReconsiderationInput {
  attemptTag: string; // e.g. "reconsider:3" — unique per reconsideration event, shared across every stage it re-runs
  directlyReconsidered: boolean;
  reconsiderationOfId?: string; // only meaningful when directlyReconsidered is true
  triggeredByActor: string;
  triggeredByQuestion: string;
  additionalContext?: string;
  /**
   * false for a re-check (lib/pipeline/recheck.ts): the stages re-run against new facts (a PO added, goods received),
   * and the reason is recorded on the trail, but it is NOT put to the Investigator/Verifier as a person's question.
   * Defaults to true: a reconsideration is a person asking the agents to look again.
   */
  askAgents?: boolean;
}

/**
 * The 7-stage pipeline runner (ENGINE.md §2): extract -> validate -> match -> investigate ->
 * verify -> policy -> audit. Each stage that actually executes writes exactly one decisions
 * row; a stage that gets skipped by a cascade-stop condition simply writes none — "every
 * stage writes exactly one row" only applies to stages that run.
 *
 * Idempotency (ENGINE.md §5): idempotency_key = hash(vendor_bill_id + node_id), no attempt
 * suffix — a genuine retry of the SAME failed stage for the SAME invoice should collapse
 * into the SAME row via writeDecision()'s own existing dedup check, not become a new row.
 * Reconsideration (lib/pipeline/reconsider.ts) is a deliberately NEW invocation, not a retry,
 * so it computes its own distinct key rather than reusing this one.
 */

/**
 * `suffix` defaults to "" for the normal, once-only pipeline pass. Reconsideration
 * (lib/pipeline/reconsider.ts) re-invokes investigate/verify/policy/audit as genuinely NEW
 * decisions, not retries of the original — it passes a distinct suffix (the reconsideration
 * attempt number) so each new invocation gets its own key instead of colliding with the
 * original pass's.
 */
function idemKey(vendorBillId: string, nodeId: string, suffix = ""): string {
  return crypto.createHash("sha256").update(`${vendorBillId}:${nodeId}${suffix}`).digest("hex");
}

async function publish(decision: Decision): Promise<void> {
  if (!decision.invoiceId) return;
  publishPipelineEvent({ invoiceId: decision.invoiceId, nodeId: decision.nodeId, decisionId: decision.id, actionTaken: decision.actionTaken, at: decision.createdAt });
}

// --- extract ---

/** What the extract decision records for an extraction: the real producer, its method, and what it was unsure of. */
function extractionDecisionFields(result: ExtractionResult) {
  if (result.review) {
    // A person checked the reading against the document and saved it: the entry is theirs. The machine reading is
    // kept as evidence (how it was read, how sure it was, what the person changed), and the confidence recorded is
    // the person's confirmation, which is what the layout check (EXC-LAYOUT) is asking for.
    const r = result.review;
    const reader = result.method === "llm" ? `the layout rules and the AI model ${result.model}` : "the layout rules";
    const claims: Claim[] = [
      { text: `Read from ${r.document.filename} (${r.document.sourceKind.replace("_", " ")}${r.document.ocrConfidence != null ? `, OCR confidence ${Math.round(r.document.ocrConfidence * 100)}%` : ""}) by ${reader}, ${Math.round(r.machineConfidence * 100)}% sure.`, tag: "grounded" },
      { text: `Checked against the document and saved by ${r.by}.`, tag: "grounded" },
      ...r.corrections.map((c) => ({ text: `Corrected by ${r.by}: ${c.field} read as "${c.read}", saved as "${c.saved}".`, tag: "grounded" as const })),
      ...result.submission.uncertain_fields.map((f) => ({ text: `Was flagged for checking: ${f}`, tag: "grounded" as const })),
    ];
    return { agentId: `human:${r.by}`, model: undefined, confidence: 1, actionTaken: "extracted", toolCalls: result.toolCalls, claims };
  }
  const claims: Claim[] = result.submission.uncertain_fields.map((f) => ({ text: `Uncertain: ${f}`, tag: "grounded" as const }));
  if (result.fallbackReason) claims.push({ text: `Extraction fallback: ${result.fallbackReason}`, tag: "grounded" });
  return {
    agentId: result.model,
    // `model` is only set when an LLM actually produced the result: the template parser is not a model.
    model: result.method === "llm" ? result.model : undefined,
    confidence: result.submission.confidence,
    actionTaken: "extracted",
    toolCalls: result.toolCalls,
    claims: claims.length > 0 ? claims : undefined,
  };
}

/**
 * `preExtracted` is passed by the ingest route, which has to run extraction BEFORE it can create
 * the bill (vendor_id is required) and has already inserted the lines. Without it, the lines
 * existing would be mistaken for a structured fixture and the decision would claim a
 * deterministic parse at confidence 1.0 for a document an extractor actually had to read.
 */
export async function runExtractStage(vendorBillId: string, preExtracted?: ExtractionResult): Promise<Decision> {
  const sql = getSql();
  const startedAt = new Date().toISOString();

  if (preExtracted) {
    const d = await writeDecision({
      invoiceId: vendorBillId, nodeId: "extract", startedAt, endedAt: new Date().toISOString(),
      ...extractionDecisionFields(preExtracted),
      idempotencyKey: idemKey(vendorBillId, "extract"),
    });
    await publish(d);
    return d;
  }

  const lineCountRows = await sql`SELECT COUNT(*)::int as n FROM vendor_bill_lines WHERE vendor_bill_id = ${vendorBillId}`;
  if (lineCountRows[0].n > 0) {
    // Structured/JSON demo fixture — lines already exist, pure parse, no LLM (ENGINE.md §2.1).
    // Structured input (JSON/EDI-style fixture or API caller): nothing was read off a document, so
    // there is no extraction uncertainty to report. "parsed" is also what runValidateStage keys on.
    const d = await writeDecision({
      invoiceId: vendorBillId, nodeId: "extract", agentId: "deterministic-parser",
      startedAt, endedAt: new Date().toISOString(), confidence: 1.0, actionTaken: "parsed",
      idempotencyKey: idemKey(vendorBillId, "extract"),
    });
    await publish(d);
    return d;
  }

  const billRows = await sql`SELECT raw_source FROM vendor_bills WHERE id = ${vendorBillId}`;
  const rawSource: string | null = billRows[0]?.raw_source ?? null;
  if (!rawSource) {
    // No pre-parsed lines and nothing to extract from — a genuine error state (ENGINE.md §5).
    const d = await writeDecision({
      invoiceId: vendorBillId, nodeId: "extract", agentId: "system",
      startedAt, endedAt: new Date().toISOString(), actionTaken: "error", reasonCode: "R99_AGENT_ERROR",
      idempotencyKey: idemKey(vendorBillId, "extract"),
    });
    await publish(d);
    return d;
  }

  const result = await extract(rawSource);
  for (const li of result.submission.line_items) {
    await sql`
      INSERT INTO vendor_bill_lines (id, vendor_bill_id, description, qty_invoiced, unit_price)
      VALUES (${crypto.randomUUID()}, ${vendorBillId}, ${li.description}, ${li.quantity}, ${li.unit_price})`;
  }
  const d = await writeDecision({
    invoiceId: vendorBillId, nodeId: "extract", startedAt, endedAt: new Date().toISOString(),
    ...extractionDecisionFields(result),
    idempotencyKey: idemKey(vendorBillId, "extract"),
  });
  await publish(d);
  return d;
}

// --- validate ---

/** The trail fields a re-run stage records: who caused the re-run and why (shown with the stage's own claims). */
function rerunFields(recon?: ReconsiderationInput) {
  return {
    reconsiderationOfId: recon?.directlyReconsidered ? recon.reconsiderationOfId : undefined,
    triggeredByActor: recon?.triggeredByActor,
    triggeredByQuestion: recon?.triggeredByQuestion,
  };
}

export async function runValidateStage(vendorBillId: string, parentDecisionId?: string, recon?: ReconsiderationInput, leadClaims: Claim[] = []): Promise<{ decision: Decision; result: PreMatchResult }> {
  const sql = getSql();
  const startedAt = new Date().toISOString();

  const billRows = await sql`SELECT * FROM vendor_bills WHERE id = ${vendorBillId}`;
  const bill = billRows[0];
  const vendorRows = await sql`SELECT * FROM vendors WHERE id = ${bill.vendor_id}`;
  const vendor = vendorRows[0];
  const lineCountRows = await sql`SELECT COUNT(*)::int as n FROM vendor_bill_lines WHERE vendor_bill_id = ${vendorBillId}`;
  const dupRows = await sql`SELECT id FROM vendor_bills WHERE vendor_id = ${bill.vendor_id} AND invoice_number = ${bill.invoice_number} AND id != ${bill.id}`;

  // Was this invoice read off a document (extractor output + its confidence) or handed to us
  // structured? The extract stage's own decision is the source of truth: "parsed" means
  // structured. A document read below the 85% threshold raises EXC-LAYOUT for a human.
  const extractRows = await sql`
    SELECT action_taken, confidence FROM decisions
    WHERE invoice_id = ${vendorBillId} AND node_id = 'extract' AND superseded_by_id IS NULL
    ORDER BY seq DESC LIMIT 1`;
  const readFromDocument = extractRows.length > 0 && extractRows[0].action_taken === "extracted";

  const input: PreMatchInput = {
    invoice: {
      invoiceDate: bill.invoice_date,
      currency: bill.currency,
      isStructuredInput: !readFromDocument,
      ocrConfidence: readFromDocument ? (extractRows[0].confidence ?? 0) : undefined,
      mandatoryFieldsPresent: lineCountRows[0].n > 0,
    },
    vendor: { trustTier: vendor.trust_tier },
    duplicateExists: dupRows.length > 0,
    today: new Date().toISOString().slice(0, 10),
  };

  const result = runPreMatchValidation(input);
  const claims: Claim[] = result.findings.map((f) => ({
    text: `${f.check}: ${f.passed ? "passed" : `failed - ${f.reason}`}`,
    tag: "grounded",
  }));

  const d = await writeDecision({
    invoiceId: vendorBillId, nodeId: "validate", agentId: "deterministic-validator",
    parentDecisionId, startedAt, endedAt: new Date().toISOString(),
    actionTaken: result.passed ? "pass" : result.blockingFinding!.action,
    reasonCode: result.blockingFinding?.exceptionCode,
    claims: [...leadClaims, ...claims],
    idempotencyKey: idemKey(vendorBillId, "validate", recon ? `:${recon.attemptTag}` : ""),
    ...rerunFields(recon),
  });
  await publish(d);
  return { decision: d, result };
}

// --- match ---

export async function runMatchStageDecision(vendorBillId: string, parentDecisionId?: string, recon?: ReconsiderationInput): Promise<{ decision: Decision; matchResult: MatchStageResult }> {
  const startedAt = new Date().toISOString();
  const matchResult = await runMatchStage(vendorBillId);
  // Each finding as its code and action, then the facts behind it (which line, which numbers), so the
  // trail, and the "ask why" explainer that answers only from it, can say what was wrong and by how much.
  const claims: Claim[] = matchResult.findings.flatMap((f): Claim[] => [
    { text: `${f.code}: ${f.action}`, tag: "grounded" },
    ...(f.fact ? [{ text: f.fact, tag: "grounded" as const }] : []),
  ]);
  if (matchResult.cleanFact) claims.push({ text: matchResult.cleanFact, tag: "grounded" });

  const d = await writeDecision({
    invoiceId: vendorBillId, nodeId: "match", agentId: "deterministic-matching-engine",
    parentDecisionId, startedAt, endedAt: new Date().toISOString(),
    actionTaken: matchResult.combined.overallAction,
    reasonCode: matchResult.combined.dominantException ?? "CLEAN_MATCH",
    claims: claims.length > 0 ? claims : undefined,
    inputsConsumed: [{ source: "match-stage-detail", retrievedAt: new Date().toISOString(), contentHash: hashJson(matchResult.detail) }],
    idempotencyKey: idemKey(vendorBillId, "match", recon ? `:${recon.attemptTag}` : ""),
    ...rerunFields(recon),
  });
  await publish(d);
  return { decision: d, matchResult };
}

// --- investigate ---

export async function runInvestigateStage(vendorBillId: string, matchDetail: unknown, parentDecisionId?: string, recon?: ReconsiderationInput): Promise<{ decision: Decision; submission?: InvestigationSubmission }> {
  const startedAt = new Date().toISOString();
  const humanContext: HumanReconsiderationContext | undefined = recon && recon.askAgents !== false
    ? { question: recon.triggeredByQuestion, additionalContext: recon.additionalContext }
    : undefined;
  const idempotencyKey = idemKey(vendorBillId, "investigate", recon ? `:${recon.attemptTag}` : "");
  const reconFields = {
    reconsiderationOfId: recon?.directlyReconsidered ? recon.reconsiderationOfId : undefined,
    triggeredByActor: recon?.triggeredByActor,
    triggeredByQuestion: recon?.triggeredByQuestion,
  };

  let result;
  try {
    result = await investigate(vendorBillId, matchDetail, humanContext);
  } catch (e) {
    const failedModel = modelFor("investigator");
    // A real, observed failure mode (not hypothetical): the model sometimes asks a plain-text
    // clarifying question instead of ever calling submit_investigation, which runToolLoop
    // correctly treats as a hard failure rather than guessing. ENGINE.md §5: never let this
    // crash the whole pipeline run uncaught — surface it as an error-state decision instead.
    const d = await writeDecision({
      invoiceId: vendorBillId, nodeId: "investigate", agentId: failedModel, model: failedModel,
      parentDecisionId, startedAt, endedAt: new Date().toISOString(),
      actionTaken: "error", reasonCode: "R99_AGENT_ERROR",
      claims: [{ text: `Investigator failed: ${e instanceof Error ? e.message : String(e)}`, tag: "grounded" }],
      idempotencyKey, ...reconFields,
    });
    await publish(d);
    return { decision: d };
  }

  const d = await writeDecision({
    invoiceId: vendorBillId, nodeId: "investigate", agentId: result.model, model: result.model,
    parentDecisionId, startedAt, endedAt: new Date().toISOString(),
    confidence: result.submission.confidence, actionTaken: result.submission.recommended_action,
    toolCalls: result.toolCalls,
    claims: [{ text: result.submission.rationale, tag: "grounded" }],
    idempotencyKey, ...reconFields,
  });
  await publish(d);
  return { decision: d, submission: result.submission };
}

// --- verify ---

export async function runVerifyStage(vendorBillId: string, matchDetail: unknown, investigation: InvestigationSubmission, parentDecisionId?: string, recon?: ReconsiderationInput): Promise<{ decision: Decision; submission?: VerificationSubmission }> {
  const startedAt = new Date().toISOString();
  const humanContext: HumanReconsiderationContext | undefined = recon && recon.askAgents !== false
    ? { question: recon.triggeredByQuestion, additionalContext: recon.additionalContext }
    : undefined;
  const idempotencyKey = idemKey(vendorBillId, "verify", recon ? `:${recon.attemptTag}` : "");
  const reconFields = {
    reconsiderationOfId: recon?.directlyReconsidered ? recon.reconsiderationOfId : undefined,
    triggeredByActor: recon?.triggeredByActor,
    triggeredByQuestion: recon?.triggeredByQuestion,
  };

  let result;
  try {
    result = await verify(vendorBillId, matchDetail, investigation, humanContext);
  } catch (e) {
    const failedModel = modelFor("verifier");
    // Same failure mode and same policy as runInvestigateStage's catch — see its comment.
    // A failed Verifier means "no independent second opinion obtained," not "pipeline crashed";
    // runPipeline treats a missing verify submission the same as verify never having run.
    const d = await writeDecision({
      invoiceId: vendorBillId, nodeId: "verify", agentId: failedModel, model: failedModel,
      parentDecisionId, startedAt, endedAt: new Date().toISOString(),
      actionTaken: "error", reasonCode: "R99_AGENT_ERROR",
      claims: [{ text: `Verifier failed: ${e instanceof Error ? e.message : String(e)}`, tag: "grounded" }],
      idempotencyKey, ...reconFields,
    });
    await publish(d);
    return { decision: d };
  }

  const d = await writeDecision({
    invoiceId: vendorBillId, nodeId: "verify", agentId: result.model, model: result.model,
    parentDecisionId, startedAt, endedAt: new Date().toISOString(),
    confidence: result.submission.confidence,
    actionTaken: result.submission.agrees ? investigation.recommended_action : "disagreement",
    toolCalls: result.toolCalls,
    claims: [{ text: result.submission.notes || "Verifier agreed with the Investigator's conclusion.", tag: "grounded" }],
    idempotencyKey, ...reconFields,
  });
  await publish(d);
  return { decision: d, submission: result.submission };
}

// --- policy ---

/** What a recommendation that is not one of the actions becomes: a person reviews the invoice. */
const UNREADABLE_RECOMMENDATION_HOLD: Action = "escalate_l1";

/** True when there is a recommendation (an Investigator ran) but it is not one of the actions. */
function isUnreadableRecommendation(recommendation?: string | null): recommendation is string {
  return recommendation != null && parseRecommendedAction(recommendation) === undefined;
}

/**
 * The Investigator's recommendation, applied the only way an AI opinion may be applied here: it can
 * make the deterministic outcome stricter, never looser. `recommendation` is null/undefined only when
 * no Investigator ran. One that is not a recognised action (prose such as "Escalate to fraud review
 * and hold payment", from an old record or a provider that let a value outside the tool's enum
 * through) is neither ignored nor guessed at: the invoice is held for a person, who can read it.
 * Used by the pipeline (whether a second opinion is needed) and by reconsideration.
 */
export function tightenedByInvestigator(engineAction: Action, recommendation?: string | null): Action {
  if (recommendation == null) return engineAction;
  const parsed = parseRecommendedAction(recommendation);
  if (!parsed) return moreRestrictive(engineAction, UNREADABLE_RECOMMENDATION_HOLD);
  // An AI may hold an invoice, but it may not void one on its own: auto_reject ends the invoice
  // (status 'void'), so an AI "reject" becomes a block, which is equally strict and leaves the
  // final call to a person. The rules' own auto_reject (a duplicate) is unaffected.
  const proposed: Action = parsed === "auto_reject" ? "block" : parsed;
  return moreRestrictive(engineAction, proposed);
}

/**
 * The policy rule, pure: the deterministic combined decision, tightened (never loosened) by the
 * Investigator's recommendation and by a Verifier that disagrees. Shared by the policy stage and by
 * reconsideration, which needs to know whether a re-review would change the outcome BEFORE it
 * writes anything.
 *
 * `heldByInvestigator` is true when the Investigator is the reason a clean match is not an
 * auto-approval. Before this, its recommendation was recorded and never applied, so "escalate:
 * a line isn't on the PO" at 0.95 confidence still ended in an automatic payment.
 */
export function computePolicyAction(
  combined: CombinedDecision,
  verifySubmission?: VerificationSubmission,
  investigatorRecommendation?: string | null,
): { action: Action; claims: Claim[]; heldByInvestigator: boolean } {
  let action: Action = combined.overallAction;
  const claims: Claim[] = [];
  const tightened = tightenedByInvestigator(action, investigatorRecommendation);
  const heldByInvestigator = tightened !== action;
  if (isUnreadableRecommendation(investigatorRecommendation)) {
    // Recorded even when the rules are already stricter, so the trail shows the recommendation was
    // read and not applied, instead of it vanishing. The text itself is not repeated here: it is
    // advice the system cannot carry out ("send it to the fraud team"), and it stays on the
    // Investigator's own record.
    const said = "The Investigator's recommendation is not one of the actions the system can apply: it was written as free-text advice.";
    claims.push({
      text: heldByInvestigator
        ? `${said} It is not guessed at: the invoice is held for a person (${tightened}, stricter than the rules' ${action}).`
        : `${said} The rules' ${action} is already at least as strict as holding it for a person, so it stands.`,
      tag: "grounded",
    });
  } else if (heldByInvestigator) {
    claims.push({ text: `The Investigator recommended ${tightened}, stricter than the rules' ${action}. An AI opinion can only tighten a decision, so ${tightened} stands.`, tag: "grounded" });
  }
  action = tightened;
  if (verifySubmission && verifySubmission.agrees === false) {
    // ENGINE.md §2.5: disagreement between Investigator and Verifier forces escalation
    // rather than trusting either alone — "more restrictive wins" against a floor of L2.
    action = moreRestrictive(action, "escalate_l2");
    claims.push({ text: `Verifier disagreed with the Investigator: ${verifySubmission.notes}`, tag: "grounded" });
  }
  return { action, claims, heldByInvestigator };
}

/**
 * computePolicyAction plus the Settings guardrails: an auto-approval that breaches the amount
 * limit or the confidence threshold becomes a human review (escalate_l1, reason POLICY_LIMIT).
 * The guardrails only ever make the outcome more cautious. Shared by the policy stage and by
 * reconsideration's "would this change the outcome?" check.
 */
export async function evaluatePolicy(
  vendorBillId: string,
  combined: CombinedDecision,
  verifySubmission: VerificationSubmission | undefined,
  investigatorConfidence: number | undefined,
  investigatorRecommendation?: string | null,
): Promise<{ action: Action; reasonCode: string; claims: Claim[] }> {
  const { action, claims, heldByInvestigator } = computePolicyAction(combined, verifySubmission, investigatorRecommendation);
  // A real exception keeps naming the decision. Only a clean match held back by the
  // Investigator needs its own reason, or it would read "Clean Match" next to a hold.
  const reasonCode = combined.dominantException ?? (heldByInvestigator ? "INVESTIGATOR_HOLD" : "CLEAN_MATCH");
  if (action !== "auto_approve") return { action, reasonCode, claims };

  const billRows = await getSql()`SELECT total_amount FROM vendor_bills WHERE id = ${vendorBillId}`;
  const breach = guardrailBreach({ amount: Number(billRows[0]?.total_amount ?? 0), investigatorConfidence }, await getPolicyLimits());
  if (!breach) return { action, reasonCode, claims };
  return { action: "escalate_l1", reasonCode: "POLICY_LIMIT", claims: [...claims, { text: breach, tag: "grounded" }] };
}

export async function runPolicyStage(params: {
  vendorBillId: string;
  combined: CombinedDecision;
  verifySubmission?: VerificationSubmission;
  /** The Investigator's reported confidence (0-1), for the Settings confidence guardrail. */
  investigatorConfidence?: number;
  /** The Investigator's recommended action; it can only tighten the outcome, and text that is not an action holds the invoice for a person. */
  investigatorRecommendation?: string | null;
  /** Set when the stop is NOT a finding about the invoice but a failure of the system itself (R99_AGENT_ERROR). */
  reasonCodeOverride?: string;
  parentDecisionId?: string;
  recon?: ReconsiderationInput;
}): Promise<Decision> {
  const evaluated = await evaluatePolicy(params.vendorBillId, params.combined, params.verifySubmission, params.investigatorConfidence, params.investigatorRecommendation);
  const { action: finalAction, claims } = evaluated;
  const policyReason = params.reasonCodeOverride ?? evaluated.reasonCode;

  const startedAt = new Date().toISOString();
  const d = await writeDecision({
    invoiceId: params.vendorBillId, nodeId: "policy", agentId: "deterministic-policy-engine",
    parentDecisionId: params.parentDecisionId, startedAt, endedAt: new Date().toISOString(),
    actionTaken: finalAction,
    reasonCode: policyReason,
    claims: claims.length > 0 ? claims : undefined,
    idempotencyKey: idemKey(params.vendorBillId, "policy", params.recon ? `:${params.recon.attemptTag}` : ""),
  });
  await publish(d);
  return d;
}

// --- audit ---

export async function runAuditStage(vendorBillId: string, policyDecision: Decision, recon?: ReconsiderationInput): Promise<Decision> {
  const sql = getSql();
  const action = policyDecision.actionTaken as Action;
  const startedAt = new Date().toISOString();
  const idempotencyKey = idemKey(vendorBillId, "audit", recon ? `:${recon.attemptTag}` : "");
  const settlementClaims: Claim[] = [];

  if (action === "auto_approve") {
    // postBillApproval (lib/ledger/journal.ts, delivered by the AO worker — see the task
    // split) posts the Dr Expense — Cr AP entry itself and sets vendor_bills.status='posted'.
    // A genuine posting failure (e.g. a bill line with no GL account coded and no PO line to
    // fall back to) is a real error state, not something to paper over — surfaced here rather
    // than crashing the pipeline uncaught (ENGINE.md §5: never silently drop an invoice into limbo).
    try {
      await postBillApproval(vendorBillId);
    } catch (e) {
      await sql`UPDATE vendor_bills SET status = 'exception' WHERE id = ${vendorBillId}`;
      const d = await writeDecision({
        invoiceId: vendorBillId, nodeId: "audit", agentId: "deterministic-policy-engine",
        parentDecisionId: policyDecision.id, startedAt, endedAt: new Date().toISOString(),
        actionTaken: "error", reasonCode: "R99_AGENT_ERROR",
        claims: [{ text: `Posting failed: ${e instanceof Error ? e.message : String(e)}`, tag: "grounded" }],
        idempotencyKey,
      });
      await publish(d);
      return d;
    }

    // The bill is now POSTED. Paying it is a separate step with its own failure mode: if the
    // payment rail fails, the ledger entry is still correct and the bill must stay 'posted'
    // (unpaid) with the failure on the record, not be flipped to 'exception' as if posting broke.
    // A credit memo is never paid: settleApprovedBill returns without paying anything.
    try {
      const settlement = await settleApprovedBill(vendorBillId);
      const billRows = await sql`SELECT currency FROM vendor_bills WHERE id = ${vendorBillId}`;
      const note = settlementNote(settlement, billRows[0]?.currency ?? "USD");
      if (note) settlementClaims.push({ text: note, tag: "grounded" });
    } catch (e) {
      const d = await writeDecision({
        invoiceId: vendorBillId, nodeId: "audit", agentId: "deterministic-policy-engine",
        parentDecisionId: policyDecision.id, startedAt, endedAt: new Date().toISOString(),
        actionTaken: "payment_failed", reasonCode: "R99_AGENT_ERROR",
        claims: [{ text: `Posted to the ledger, but payment did not go out: ${e instanceof Error ? e.message : String(e)}`, tag: "grounded" }],
        idempotencyKey,
      });
      await publish(d);
      return d;
    }
  } else {
    const newStatus = action === "auto_reject" ? "void" : "exception";
    await sql`UPDATE vendor_bills SET status = ${newStatus} WHERE id = ${vendorBillId}`;
    
    if (action === "escalate_l1" || action === "escalate_l2") {
      const billRows = await sql`SELECT vb.invoice_number, v.name as vendor_name FROM vendor_bills vb JOIN vendors v ON v.id = vb.vendor_id WHERE vb.id = ${vendorBillId}`;
      if (billRows.length > 0) {
        const b = billRows[0];
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:5173";
        // The workbench's own invoice page (it used to point at /queue/, which no route serves).
        const url = `${baseUrl}/app/invoice/${vendorBillId}`;
        await notifyReviewer(
          "AP Supervisor",
          vendorBillId,
          `Invoice ${b.invoice_number} from ${b.vendor_name} requires manual review (${policyDecision.reasonCode}).`,
          url,
          url
        ).catch(e => console.error("Telegram notification failed implicitly", e));
      }
    }
  }

  const d = await writeDecision({
    invoiceId: vendorBillId, nodeId: "audit", agentId: "deterministic-policy-engine",
    parentDecisionId: policyDecision.id, startedAt, endedAt: new Date().toISOString(),
    actionTaken: action, reasonCode: policyDecision.reasonCode,
    claims: settlementClaims.length > 0 ? settlementClaims : undefined,
    idempotencyKey,
  });
  await publish(d);
  return d;
}

// --- the full pipeline ---

/** Tier-2-eligible per ENGINE.md §2.5: only escalate_l2/block get a second opinion — never a plain rule-triggered block with nothing to adjudicate. Exported for reconsider.ts's own cascade re-run. */
export function isTier2Eligible(action: Action): boolean {
  return action === "escalate_l2" || action === "block";
}

function asCascadedDecision(action: Action, exceptionCode: CombinedDecision["dominantException"]): CombinedDecision {
  return { overallAction: action, dominantException: exceptionCode, cascaded: true, deferredExceptions: [] };
}

/**
 * Runs the pipeline and guarantees the bill never stays at 'processing' if a stage throws
 * something unexpected (DB outage, bug): it is moved to 'exception' with an R99 audit decision,
 * so it shows up in the reviewer's queue instead of silently spinning forever. The original
 * error is re-thrown for the caller to log.
 */
export async function runPipeline(vendorBillId: string, opts: { extraction?: ExtractionResult } = {}): Promise<void> {
  try {
    await runPipelineStages(vendorBillId, opts);
  } catch (e) {
    await recordPipelineCrash(vendorBillId, e);
    throw e;
  }
}

/**
 * A re-run of the stages after extraction (lib/pipeline/recheck.ts): every stage gets the re-run's tag (fresh
 * idempotency keys, who triggered it and why), `leadClaims` open the new validate decision (the reason, in words),
 * and `onFirstDecision` runs once that validate decision exists, so the caller can mark the run it replaces as
 * superseded by it.
 */
export interface RerunOptions {
  recon: ReconsiderationInput;
  leadClaims: Claim[];
  onFirstDecision: (first: Decision) => Promise<void>;
}

/** Validate onward, for an invoice whose extract decision already exists; with the same crash guarantee as runPipeline. */
export async function rerunFromValidate(vendorBillId: string, extractDecisionId: string, rerun: RerunOptions): Promise<void> {
  try {
    await runFromValidate(vendorBillId, extractDecisionId, rerun);
  } catch (e) {
    await recordPipelineCrash(vendorBillId, e, `:${rerun.recon.attemptTag}:crash`);
    throw e;
  }
}

async function recordPipelineCrash(vendorBillId: string, cause: unknown, keySuffix = ":crash"): Promise<void> {
  const message = (cause instanceof Error ? cause.message : String(cause)).slice(0, 300);
  try {
    const sql = getSql();
    await sql`UPDATE vendor_bills SET status = 'exception' WHERE id = ${vendorBillId} AND status = 'processing'`;
    const now = new Date().toISOString();
    const d = await writeDecision({
      invoiceId: vendorBillId, nodeId: "audit", agentId: "system", startedAt: now, endedAt: now,
      actionTaken: "error", reasonCode: "R99_AGENT_ERROR",
      claims: [{ text: `Pipeline stopped unexpectedly: ${message}`, tag: "grounded" }],
      idempotencyKey: idemKey(vendorBillId, "audit", keySuffix),
    });
    await publish(d);
  } catch (inner) {
    // The ledger itself is unreachable; nothing more can be recorded. Both errors go to the log
    // so an operator can find the stuck bill by id.
    console.error(`runPipeline: bill ${vendorBillId} crashed (${message}) and the crash could not be recorded:`, inner);
  }
}

async function runPipelineStages(vendorBillId: string, opts: { extraction?: ExtractionResult }): Promise<void> {
  const extractDecision = await runExtractStage(vendorBillId, opts.extraction);
  if (extractDecision.actionTaken === "error") {
    const policyDecision = await runPolicyStage({ vendorBillId, combined: asCascadedDecision("block", null), reasonCodeOverride: "R99_AGENT_ERROR", parentDecisionId: extractDecision.id });
    await runAuditStage(vendorBillId, policyDecision);
    return;
  }

  await runFromValidate(vendorBillId, extractDecision.id);
}

/** validate -> match -> investigate -> verify -> policy -> audit. The first run of an invoice, or a re-run (`rerun`). */
async function runFromValidate(vendorBillId: string, extractDecisionId: string, rerun?: RerunOptions): Promise<void> {
  const recon = rerun?.recon;
  const { decision: validateDecision, result: validateResult } = await runValidateStage(vendorBillId, extractDecisionId, recon, rerun?.leadClaims);
  await rerun?.onFirstDecision(validateDecision);
  if (!validateResult.passed) {
    // Every pre-match gate failure is a deterministic, non-judgment-dependent stop — none of
    // the six checks need an Investigator's opinion, so all of them cascade straight to policy,
    // not just the 4 codes decision-matrix.ts's own CASCADE_STOP_CODES formally names.
    const blocking = validateResult.blockingFinding!;
    const combined = asCascadedDecision(blocking.action as Action, blocking.exceptionCode ?? null);
    const policyDecision = await runPolicyStage({ vendorBillId, combined, parentDecisionId: validateDecision.id, recon });
    await runAuditStage(vendorBillId, policyDecision, recon);
    return;
  }

  const { decision: matchDecision, matchResult } = await runMatchStageDecision(vendorBillId, validateDecision.id, recon);
  if (matchResult.combined.cascaded) {
    const policyDecision = await runPolicyStage({ vendorBillId, combined: matchResult.combined, parentDecisionId: matchDecision.id, recon });
    await runAuditStage(vendorBillId, policyDecision, recon);
    return;
  }

  // Every non-cascaded invoice still gets an investigate-stage decision row, even a clean
  // auto-approve one (ENGINE.md §2.4: "a fast pass-through with no tool calls at all" — the
  // Investigator's own system prompt already tells it not to force evidence-gathering where
  // none is needed; this is what makes that a real, on-the-record pass, not a skipped stage).
  const { decision: investigateDecision, submission: investigation } = await runInvestigateStage(vendorBillId, matchResult.detail, matchDecision.id, recon);
  if (!investigation) {
    // The Investigator failed outright (ENGINE.md §5) — nothing to verify or police against;
    // block for human attention rather than guessing at a downstream action.
    const policyDecision = await runPolicyStage({ vendorBillId, combined: asCascadedDecision("block", null), reasonCodeOverride: "R99_AGENT_ERROR", parentDecisionId: investigateDecision.id, recon });
    await runAuditStage(vendorBillId, policyDecision, recon);
    return;
  }

  let verifySubmission: VerificationSubmission | undefined;
  let lastDecisionId = investigateDecision.id;
  // Tier-2 eligibility uses the outcome after the Investigator's (tighten-only) recommendation, the
  // same rule reconsideration uses: if the Investigator wants a block, a second opinion is recorded.
  if (isTier2Eligible(tightenedByInvestigator(matchResult.combined.overallAction, investigation.recommended_action))) {
    const { decision: verifyDecision, submission } = await runVerifyStage(vendorBillId, matchResult.detail, investigation, investigateDecision.id, recon);
    verifySubmission = submission;
    lastDecisionId = verifyDecision.id;
  }

  const policyDecision = await runPolicyStage({
    vendorBillId, combined: matchResult.combined, verifySubmission,
    investigatorConfidence: investigation.confidence, investigatorRecommendation: investigation.recommended_action,
    parentDecisionId: lastDecisionId, recon,
  });
  await runAuditStage(vendorBillId, policyDecision, recon);
}
