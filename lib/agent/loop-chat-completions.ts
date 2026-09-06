import OpenAI from "openai";
import type { ToolCallLog } from "@/lib/types";
import type { ToolDef } from "@/lib/agent/tools";
import { hashJson } from "@/lib/agent/hash";
import type { AgentLoopResult } from "@/lib/agent/loop-responses";

/**
 * Multi-turn tool-calling loop against TensorMux's OpenAI-compatible endpoint (SPEC.md:
 * "OpenAI-compatible endpoint" — verified empirically to mean Chat Completions, NOT the
 * newer Responses API that only OpenAI itself implements; confirmed with a real call before
 * writing this). Used only by the Verifier. Genuinely different wire format from
 * loop-responses.ts (assistant `tool_calls` array + `role:"tool"` messages, vs. flat
 * function_call/function_call_output items) — kept as its own file rather than forced into
 * one generic loop across two incompatible protocols.
 */

const TIMEOUT_MS = 20_000;
const MAX_RETRIES = 1; // ENGINE.md §5, same policy as the Responses loop

let client: OpenAI | undefined;
function getTensorMuxClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.TENSORMUX_API_KEY;
    const baseURL = process.env.TENSORMUX_BASE_URL;
    if (!apiKey || !baseURL) throw new Error("TENSORMUX_API_KEY / TENSORMUX_BASE_URL are not set");
    client = new OpenAI({ apiKey, baseURL });
  }
  return client;
}

function toChatCompletionTool(toolDef: ToolDef): OpenAI.Chat.ChatCompletionTool {
  return {
    type: "function",
    function: { name: toolDef.name, description: toolDef.description ?? undefined, parameters: toolDef.parameters ?? undefined },
  };
}

export interface RunChatCompletionsLoopParams<TSubmission> {
  model?: string;
  instructions: string;
  initialInput: string;
  tools: ToolDef[];
  submissionToolName: string;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  maxTurns?: number;
}

export async function runChatCompletionsLoop<TSubmission>(params: RunChatCompletionsLoopParams<TSubmission>): Promise<AgentLoopResult<TSubmission>> {
  const { instructions, initialInput, tools, submissionToolName, executeTool, maxTurns = 8 } = params;
  const model = params.model || process.env.TENSORMUX_MODEL;
  if (!model) throw new Error("TENSORMUX_MODEL is not set and no model was passed explicitly");
  const openai = getTensorMuxClient();
  const chatTools = tools.map(toChatCompletionTool);

  let messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: instructions },
    { role: "user", content: initialInput },
  ];
  const toolCalls: ToolCallLog[] = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await openai.chat.completions.create(
      { model, messages, tools: chatTools, max_tokens: 4000 },
      { timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES },
    );

    const message = response.choices[0]?.message;
    if (!message) throw new Error(`Agent loop: TensorMux returned no message on turn ${turn}`);

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      throw new Error(`Agent loop: model produced no tool call on turn ${turn} (instructions require calling ${submissionToolName}); content was: ${message.content}`);
    }

    messages = [...messages, message];

    const submissionCall = calls.find((c) => c.type === "function" && c.function.name === submissionToolName);
    if (submissionCall && submissionCall.type === "function") {
      const args = JSON.parse(submissionCall.function.arguments) as Record<string, unknown>;
      toolCalls.push({ name: submissionCall.function.name, args, rawResult: args, resultHash: hashJson(args) });
      return { submission: args as TSubmission, toolCalls, turns: turn + 1 };
    }

    for (const call of calls) {
      if (call.type !== "function") continue;
      const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      const result = await executeTool(call.function.name, args);
      toolCalls.push({ name: call.function.name, args, rawResult: result, resultHash: hashJson(result) });
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  throw new Error(`Agent loop exceeded maxTurns (${maxTurns}) without a call to ${submissionToolName}`);
}
