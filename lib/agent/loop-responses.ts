import OpenAI from "openai";
import type { ToolCallLog } from "@/lib/types";
import type { ToolDef } from "@/lib/agent/tools";
import { hashJson } from "@/lib/agent/hash";

/**
 * Multi-turn tool-calling loop against OpenAI's Responses API (ENGINE.md §3), used by the
 * Investigator (multi-turn, evidence-gathering) and the Extractor (effectively single-turn —
 * no evidence tools, just the one submission tool). The Verifier uses TensorMux instead
 * (lib/agent/loop-chat-completions.ts) — a genuinely different wire format, not a variant
 * of this one, so it's not force-unified into a single generic loop.
 *
 * Stateless by design: the full `input` array is rebuilt and resent every turn rather than
 * relying on `previous_response_id` server-side threading, since the complete transcript is
 * exactly what needs to end up in the decisions row's `tool_calls` log anyway.
 */

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-5-nano";
const TIMEOUT_MS = 20_000;
const MAX_RETRIES = 1; // ENGINE.md §5: one bounded retry — the SDK's own policy only retries timeouts/5xx/429, never a plain 4xx

let client: OpenAI | undefined;
function getOpenAiClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
    client = new OpenAI({ apiKey });
  }
  return client;
}

export interface AgentLoopResult<TSubmission> {
  submission: TSubmission;
  toolCalls: ToolCallLog[];
  turns: number;
}

export interface RunResponsesLoopParams<TSubmission> {
  model?: string;
  instructions: string;
  initialInput: string;
  tools: ToolDef[];
  submissionToolName: string;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Bounds the loop — ENGINE.md's own standard ("anything unbounded is a future outage") applies to agent turns too. */
  maxTurns?: number;
}

export async function runResponsesLoop<TSubmission>(params: RunResponsesLoopParams<TSubmission>): Promise<AgentLoopResult<TSubmission>> {
  const { model = DEFAULT_MODEL, instructions, initialInput, tools, submissionToolName, executeTool, maxTurns = 8 } = params;
  const openai = getOpenAiClient();

  let input: OpenAI.Responses.ResponseInputItem[] = [{ role: "user", content: initialInput }];
  const toolCalls: ToolCallLog[] = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await openai.responses.create(
      { model, instructions, input, tools, parallel_tool_calls: true },
      { timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES },
    );

    const functionCalls = response.output.filter(
      (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === "function_call",
    );

    if (functionCalls.length === 0) {
      throw new Error(`Agent loop: model produced no function call on turn ${turn} (instructions require calling ${submissionToolName}); output_text was: ${response.output_text}`);
    }

    // response.output's declared type is a ~30-member union covering every tool type the
    // Responses API supports (computer-use, file-search, mcp, ...), and one of those
    // (ResponseComputerToolCallOutputItem) isn't structurally assignable back to
    // ResponseInputItem (its `status` allows 'failed', which the input variant doesn't).
    // This tool set never uses computer-use, so that variant can't actually appear at
    // runtime — the cast is narrow and justified, not a blanket type-safety opt-out.
    input = [...input, ...(response.output as unknown as OpenAI.Responses.ResponseInputItem[])];

    const submissionCall = functionCalls.find((fc) => fc.name === submissionToolName);
    if (submissionCall) {
      const args = JSON.parse(submissionCall.arguments) as Record<string, unknown>;
      toolCalls.push({ name: submissionCall.name, args, rawResult: args, resultHash: hashJson(args) });
      return { submission: args as TSubmission, toolCalls, turns: turn + 1 };
    }

    for (const fc of functionCalls) {
      const args = JSON.parse(fc.arguments) as Record<string, unknown>;
      const result = await executeTool(fc.name, args);
      toolCalls.push({ name: fc.name, args, rawResult: result, resultHash: hashJson(result) });
      input.push({ type: "function_call_output", call_id: fc.call_id, output: JSON.stringify(result) });
    }
  }

  throw new Error(`Agent loop exceeded maxTurns (${maxTurns}) without a call to ${submissionToolName}`);
}
