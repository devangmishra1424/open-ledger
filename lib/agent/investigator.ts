import { investigatorPrompt } from "@/lib/agent/prompts";
import { EVIDENCE_TOOLS, SUBMIT_INVESTIGATION, executeTool } from "@/lib/agent/tools";
import { runToolLoop, type AgentLoopResult } from "@/lib/agent/loop";
import { normalizeConfidence } from "@/lib/agent/llm";
import { parseRecommendedAction } from "@/lib/matching/decision-matrix";

/** Matches submit_investigation's parameter schema in lib/agent/tools.ts exactly. */
export interface InvestigationSubmission {
  exception_types: string[];
  confidence: number;
  rationale: string;
  /**
   * One of the six Actions (the schema's enum). Stays a string: a value the model got wrong, and an
   * old free-text record rebuilt by reconsideration, are kept as written, and policy holds those for
   * a person (tightenedByInvestigator in lib/pipeline/orchestrator.ts).
   */
  recommended_action: string;
}

export interface HumanReconsiderationContext {
  question: string;
  additionalContext?: string;
}

/**
 * `matchResult` is deliberately untyped here — its actual shape is owned by
 * lib/pipeline (the orchestrator assembles it from pre-match-validation + line-match +
 * decision-matrix output). This module's only job is to hand it to the model as context
 * and run the investigation loop; it doesn't need to understand the shape itself.
 *
 * `humanContext`, when present, is a reconsideration (lib/pipeline/reconsider.ts, ALGORITHMS.md
 * §3): the same node re-invoked with fresh current-state context plus a human's question
 * appended on top — never a stored, staling prompt blob.
 */
export async function investigate(invoiceId: string, matchResult: unknown, humanContext?: HumanReconsiderationContext): Promise<AgentLoopResult<InvestigationSubmission>> {
  const payload: Record<string, unknown> = { invoice_id: invoiceId, match_result: matchResult };
  if (humanContext) {
    payload.human_question = humanContext.question;
    if (humanContext.additionalContext) payload.human_additional_context = humanContext.additionalContext;
  }
  const result = await runToolLoop<InvestigationSubmission>({
    role: "investigator",
    instructions: investigatorPrompt(invoiceId),
    initialInput: JSON.stringify(payload),
    tools: [...EVIDENCE_TOOLS, SUBMIT_INVESTIGATION],
    submissionToolName: "submit_investigation",
    executeTool,
  });
  result.submission.confidence = normalizeConfidence(result.submission.confidence);
  result.submission.recommended_action = readRecommendedAction(invoiceId, result.submission.recommended_action);
  return result;
}

/**
 * The tool schema constrains recommended_action to the six actions, but a provider may not enforce
 * an enum, so the value is checked here too. Spelling noise ("Escalate-L2") is stored as the action
 * it names. Anything else (prose) is kept word for word rather than dropped or guessed at: policy
 * then holds the invoice for a person, who can read it. A missing or non-string value is a malformed
 * submission and fails the stage, which runInvestigateStage records as an agent error (a block).
 */
function readRecommendedAction(invoiceId: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`Investigator submitted no recommended_action for invoice ${invoiceId} (got ${String(JSON.stringify(value)).slice(0, 100)})`);
  }
  const action = parseRecommendedAction(value);
  if (action) return action;
  // Seeing this means the provider let a value outside the enum through; the invoice is held, not paid.
  console.warn(`[investigator] invoice ${invoiceId}: recommended_action is not one of the actions; kept as written, policy will hold it for a person: ${JSON.stringify(value.slice(0, 200))}`);
  return value;
}
