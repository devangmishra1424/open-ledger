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

/**
 * `matchResult` is deliberately untyped here — its actual shape is owned by
 * lib/pipeline (the orchestrator assembles it from pre-match-validation + line-match +
 * decision-matrix output). This module's only job is to hand it to the model as context
 * and run the investigation loop; it doesn't need to understand the shape itself.
 */
export async function investigate(invoiceId: string, matchResult: unknown): Promise<AgentLoopResult<InvestigationSubmission>> {
  return runResponsesLoop<InvestigationSubmission>({
    instructions: investigatorPrompt(invoiceId),
    initialInput: JSON.stringify({ invoice_id: invoiceId, match_result: matchResult }),
    tools: [...EVIDENCE_TOOLS, SUBMIT_INVESTIGATION],
    submissionToolName: "submit_investigation",
    executeTool,
  });
}
