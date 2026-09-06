import { EXTRACTOR_PROMPT } from "@/lib/agent/prompts";
import { SUBMIT_EXTRACTION } from "@/lib/agent/tools";
import { runResponsesLoop, type AgentLoopResult } from "@/lib/agent/loop-responses";

/** Matches submit_extraction's parameter schema in lib/agent/tools.ts exactly. */
export interface ExtractionSubmission {
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  po_reference: string | null;
  line_items: Array<{ description: string; quantity: number; unit_price: number }>;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  currency: string | null;
  confidence: number;
  uncertain_fields: string[];
}

/**
 * Only for the 1-2 unstructured PDF/email samples (ENGINE.md §2.1) — the ~28 structured/JSON
 * demo fixtures are parsed directly, no LLM call. No evidence tools: this is a single-turn
 * extraction, not an investigation, so `executeTool` should never actually be invoked —
 * it throws instead of silently returning something if it somehow is.
 */
export async function extract(invoiceText: string): Promise<AgentLoopResult<ExtractionSubmission>> {
  return runResponsesLoop<ExtractionSubmission>({
    instructions: EXTRACTOR_PROMPT,
    initialInput: invoiceText,
    tools: [SUBMIT_EXTRACTION],
    submissionToolName: "submit_extraction",
    executeTool: async (name) => {
      throw new Error(`extract(): unexpected tool call '${name}' — the Extractor has no evidence tools`);
    },
    maxTurns: 2,
  });
}
