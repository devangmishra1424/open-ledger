import { verifierPrompt } from "@/lib/agent/prompts";
import { EVIDENCE_TOOLS, SUBMIT_VERIFICATION, executeTool } from "@/lib/agent/tools";
import { runChatCompletionsLoop } from "@/lib/agent/loop-chat-completions";
import type { AgentLoopResult } from "@/lib/agent/loop-responses";

/** Matches submit_verification's parameter schema in lib/agent/tools.ts exactly. */
export interface VerificationSubmission {
  agrees: boolean;
  exception_types: string[];
  confidence: number;
  notes: string;
}

/**
 * TensorMux (glm-4-7-flash) as an independent second opinion — only invoked by the pipeline
 * for Tier-2-eligible decisions (ENGINE.md §2.5), never for a plain rule-triggered block with
 * nothing to adjudicate. Given the same MatchResult AND the Investigator's own conclusion, so
 * it can explicitly agree or flag disagreement — not a second blind investigation.
 */
export async function verify(invoiceId: string, matchResult: unknown, investigation: unknown): Promise<AgentLoopResult<VerificationSubmission>> {
  return runChatCompletionsLoop<VerificationSubmission>({
    instructions: verifierPrompt(invoiceId),
    initialInput: JSON.stringify({ invoice_id: invoiceId, match_result: matchResult, investigator_conclusion: investigation }),
    tools: [...EVIDENCE_TOOLS, SUBMIT_VERIFICATION],
    submissionToolName: "submit_verification",
    executeTool,
  });
}
