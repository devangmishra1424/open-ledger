import { investigatorPrompt } from "@/lib/agent/prompts";
import { EVIDENCE_TOOLS, SUBMIT_INVESTIGATION, executeTool } from "@/lib/agent/tools";
import { runResponsesLoop, type AgentLoopResult } from "@/lib/agent/loop-responses";

/** Matches submit_investigation's parameter schema in lib/agent/tools.ts exactly. */
export interface InvestigationSubmission {
  exception_types: string[];
  confidence: number;
  rationale: string;
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
  return runResponsesLoop<InvestigationSubmission>({
    instructions: investigatorPrompt(invoiceId),
    initialInput: JSON.stringify(payload),
    tools: [...EVIDENCE_TOOLS, SUBMIT_INVESTIGATION],
    submissionToolName: "submit_investigation",
    executeTool,
  });
}
