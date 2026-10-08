import { verifierPrompt } from "@/lib/agent/prompts";
import { EVIDENCE_TOOLS, SUBMIT_VERIFICATION, executeTool } from "@/lib/agent/tools";
import { runToolLoop, type AgentLoopResult } from "@/lib/agent/loop";
import type { HumanReconsiderationContext } from "@/lib/agent/investigator";

/** Matches submit_verification's parameter schema in lib/agent/tools.ts exactly. */
export interface VerificationSubmission {
  agrees: boolean;
  exception_types: string[];
  confidence: number;
  notes: string;
}

/**
 * An independent second opinion from a different model family than the Investigator (lib/agent/llm.ts) — only invoked by the pipeline
 * for Tier-2-eligible decisions (ENGINE.md §2.5), never for a plain rule-triggered block with
 * nothing to adjudicate. Given the same MatchResult AND the Investigator's own conclusion, so
 * it can explicitly agree or flag disagreement — not a second blind investigation.
 */
export async function verify(invoiceId: string, matchResult: unknown, investigation: unknown, humanContext?: HumanReconsiderationContext): Promise<AgentLoopResult<VerificationSubmission>> {
  const payload: Record<string, unknown> = { invoice_id: invoiceId, match_result: matchResult, investigator_conclusion: investigation };
  if (humanContext) {
    payload.human_question = humanContext.question;
    if (humanContext.additionalContext) payload.human_additional_context = humanContext.additionalContext;
  }
  return runToolLoop<VerificationSubmission>({
    role: "verifier",
    instructions: verifierPrompt(invoiceId),
    initialInput: JSON.stringify(payload),
    tools: [...EVIDENCE_TOOLS, SUBMIT_VERIFICATION],
    submissionToolName: "submit_verification",
    executeTool,
  });
}
