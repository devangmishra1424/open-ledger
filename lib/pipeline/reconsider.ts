import { getDecision, countReconsiderations, getDecisionsAfter, markSuperseded } from "@/lib/ledger/decisions";
import { runMatchStage } from "@/lib/pipeline/match-stage";
import {
  runInvestigateStage, runVerifyStage, runPolicyStage, runAuditStage, isTier2Eligible,
  type ReconsiderationInput,
} from "@/lib/pipeline/orchestrator";
import type { Action, CombinedDecision } from "@/lib/matching/decision-matrix";
import type { InvestigationSubmission } from "@/lib/agent/investigator";
import type { VerificationSubmission } from "@/lib/agent/verifier";
import type { Decision, ReconsiderResponse } from "@/lib/types";

/**
 * The "ask the predecessor" mechanic (ENGINE.md §6b, ALGORITHMS.md §3) — a genuine
 * re-invocation of the original node with fresh current-state context plus the human's
 * question, not just a canned re-explanation. Only `investigate` and `verify` are
 * reconsiderable: they're the judgment-bearing agent nodes ("the literal analogue of calling
 * your predecessor and asking them to double-check"); a deterministic rule engine (match,
 * validate, policy) has no judgment to reconsider.
 *
 * APPROXIMATION, stated honestly: the pseudocode's cascade trigger is
 * "exceptionTypes changed OR actionTaken changed". This project's `decisions` schema doesn't
 * persist an agent submission's full `exception_types` array as its own column (it's folded
 * into `reason_code`, `action_taken`, and `claims` at write time — see runInvestigateStage/
 * runVerifyStage in orchestrator.ts) — so the cascade trigger here compares `actionTaken`
 * only. In practice this is the field that actually matters for the downstream re-run
 * decision anyway.
 */

export interface ReconsiderInput {
  originalDecisionId: string;
  question: string;
  additionalContext?: string;
  actor: string;
}

export type ReconsiderOutcome = ReconsiderResponse | { error: string; action: "escalate_senior" };

const MAX_RECONSIDERATIONS = 3;

export function isEscalateSeniorResult(r: ReconsiderOutcome): r is { error: string; action: "escalate_senior" } {
  return "action" in r && r.action === "escalate_senior";
}

/** Best-effort reconstruction of an InvestigationSubmission from a stored Decision row — see the module doc's honesty note on exception_types. */
function investigationFromDecision(d: Decision, fallbackExceptionCode: string | null): InvestigationSubmission {
  return {
    exception_types: d.reasonCode ? [d.reasonCode] : fallbackExceptionCode ? [fallbackExceptionCode] : [],
    confidence: d.confidence ?? 0,
    rationale: d.claims?.[0]?.text ?? "",
    recommended_action: d.actionTaken ?? "",
  };
}

export async function reconsider(input: ReconsiderInput): Promise<ReconsiderOutcome> {
  const original = await getDecision(input.originalDecisionId);
  if (!original) throw new Error(`reconsider: no decision found with id '${input.originalDecisionId}'`);
  if (!original.invoiceId) throw new Error(`reconsider: decision '${original.id}' has no invoiceId — cannot rebuild context to reconsider it`);
  if (original.nodeId !== "investigate" && original.nodeId !== "verify") {
    throw new Error(`reconsider: node '${original.nodeId}' is deterministic, not judgment-bearing — reconsideration only applies to 'investigate' or 'verify'`);
  }

  const priorCount = await countReconsiderations(input.originalDecisionId);
  if (priorCount >= MAX_RECONSIDERATIONS) {
    return {
      error: "This has been reconsidered 3 times already — escalating to a senior reviewer instead of re-running the agent again.",
      action: "escalate_senior",
    };
  }

  const recon: ReconsiderationInput = {
    attemptTag: `reconsider:${priorCount + 1}`,
    directlyReconsidered: true,
    reconsiderationOfId: original.id,
    triggeredByActor: input.actor,
    triggeredByQuestion: input.question,
    additionalContext: input.additionalContext,
  };

  // Rebuild fresh context from CURRENT DB state, exactly like the original pipeline run did —
  // never a stored, staling prompt blob (ALGORITHMS.md §3's own note).
  const matchResult = await runMatchStage(original.invoiceId);

  let newDecision: Decision;
  if (original.nodeId === "investigate") {
    const { decision } = await runInvestigateStage(original.invoiceId, matchResult.detail, original.parentDecisionId, recon);
    newDecision = decision;
  } else {
    if (!original.parentDecisionId) throw new Error(`reconsider: verify decision '${original.id}' has no parentDecisionId to recover its investigate context from`);
    const investigateDecision = await getDecision(original.parentDecisionId);
    if (!investigateDecision) throw new Error(`reconsider: could not find the investigate decision '${original.parentDecisionId}' that verify decision '${original.id}' was based on`);
    const investigation = investigationFromDecision(investigateDecision, matchResult.combined.dominantException);
    const { decision } = await runVerifyStage(original.invoiceId, matchResult.detail, investigation, original.parentDecisionId, recon);
    newDecision = decision;
  }

  if (newDecision.actionTaken === "error") {
    // The re-invoked agent failed outright (ENGINE.md §5) — nothing coherent to cascade
    // against; report the error decision itself rather than casting "error" into an Action
    // and re-running policy/audit on a lie.
    return { newDecision, cascaded: false, supersededDecisionIds: [] };
  }

  const cascaded = newDecision.actionTaken !== original.actionTaken;
  const supersededDecisionIds: string[] = [];

  if (cascaded) {
    // Re-run the FULL precedence/decision-matrix logic from verify onward (ALGORITHMS.md §3) —
    // not just "policy" in isolation, since a changed conclusion can change which downstream
    // stages even apply.
    const downstream = await getDecisionsAfter(original);
    for (const d of downstream) {
      await markSuperseded(d.id, newDecision.id);
      supersededDecisionIds.push(d.id);
    }

    const combinedForPolicy: CombinedDecision = {
      overallAction: newDecision.actionTaken as Action,
      dominantException: matchResult.combined.dominantException,
      cascaded: false,
      deferredExceptions: matchResult.combined.deferredExceptions,
    };

    let verifySubmission: VerificationSubmission | undefined;
    let lastId = newDecision.id;

    if (original.nodeId === "investigate" && isTier2Eligible(combinedForPolicy.overallAction)) {
      // The reconsidered investigate's new conclusion pushed this into tier-2 territory (or
      // it already was) — verify needs a fresh pass against the NEW investigation, not the
      // stale one from before this reconsideration.
      const investigation = investigationFromDecision(newDecision, matchResult.combined.dominantException);
      const { decision: verifyDecision, submission } = await runVerifyStage(original.invoiceId, matchResult.detail, investigation, newDecision.id, recon);
      verifySubmission = submission;
      lastId = verifyDecision.id;
    } else if (original.nodeId === "verify") {
      // The reconsidered node WAS verify itself — its new submission is what policy needs.
      verifySubmission = { agrees: newDecision.actionTaken !== "disagreement", exception_types: [], confidence: newDecision.confidence ?? 0, notes: newDecision.claims?.[0]?.text ?? "" };
    }

    const policyDecision = await runPolicyStage({ vendorBillId: original.invoiceId, combined: combinedForPolicy, verifySubmission, parentDecisionId: lastId, recon });
    await runAuditStage(original.invoiceId, policyDecision, recon);
  }

  return { newDecision, cascaded, supersededDecisionIds };
}
