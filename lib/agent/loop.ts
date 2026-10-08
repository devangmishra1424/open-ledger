import type OpenAI from "openai";
import type { ToolCallLog } from "@/lib/types";
import type { ToolDef } from "@/lib/agent/tools";
import { hashJson } from "@/lib/agent/hash";
import { getLlmClient, modelFor, explainLlmError, isMalformedToolCall, type AgentRole } from "@/lib/agent/llm";

/**
 * The single multi-turn tool-calling loop every agent (Extractor, Investigator, Verifier) runs
 * on: send the conversation, execute whatever evidence tools the model calls, feed the results
 * back, and finish when it calls the role's `submit_*` tool. Replaces the two near-identical
 * copies that used to live in loop-responses.ts and loop-chat-completions.ts — both were
 * already Chat Completions against Groq, so the split (and the "Responses API" name) described
 * a protocol difference that did not exist.
 *
 * Guard rails: every request has a timeout and one bounded SDK retry (the SDK retries only
 * transient failures — 429/5xx/connection — never a 4xx); a response the provider rejects because
 * the MODEL emitted an invalid tool call is re-sampled at most MAX_RESAMPLES times (the one 4xx
 * where asking again is a different outcome — see isMalformedToolCall); the loop is capped at `maxTurns`;
 * the model must call a tool every turn (`tool_choice: "required"`), so it cannot stall by
 * asking a plain-text question; malformed tool arguments fail loudly instead of being guessed.
 */

const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 1;
const MAX_RESAMPLES = 2;

export interface AgentLoopResult<TSubmission> {
  submission: TSubmission;
  toolCalls: ToolCallLog[];
  turns: number;
  /** The model id that actually produced this result — what the ledger records. */
  model: string;
}

export interface RunToolLoopParams {
  role: AgentRole;
  instructions: string;
  initialInput: string;
  tools: ToolDef[];
  submissionToolName: string;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  maxTurns?: number;
  /** Test/override hook; normally the role's configured model (lib/agent/llm.ts). */
  model?: string;
  /** Test hook: a stand-in for the provider client. */
  client?: Pick<OpenAI, "chat">;
}

function toChatCompletionTool(toolDef: ToolDef): OpenAI.Chat.ChatCompletionTool {
  return {
    type: "function",
    function: { name: toolDef.name, description: toolDef.description ?? undefined, parameters: toolDef.parameters ?? undefined },
  };
}

function parseArgs(toolName: string, raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Agent loop: model returned malformed arguments for tool '${toolName}' (${e instanceof Error ? e.message : String(e)}): ${raw.slice(0, 200)}`);
  }
}

export async function runToolLoop<TSubmission>(params: RunToolLoopParams): Promise<AgentLoopResult<TSubmission>> {
  const { role, instructions, initialInput, tools, submissionToolName, executeTool, maxTurns = 8 } = params;
  const model = params.model ?? modelFor(role);
  const llm = params.client ?? getLlmClient();
  const chatTools = tools.map(toChatCompletionTool);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: instructions },
    { role: "user", content: initialInput },
  ];
  const toolCalls: ToolCallLog[] = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    let response: OpenAI.Chat.ChatCompletion | undefined;
    for (let attempt = 0; response === undefined; attempt++) {
      try {
        response = await llm.chat.completions.create(
          { model, messages, tools: chatTools, tool_choice: "required", max_tokens: 4000 },
          { timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES },
        );
      } catch (e) {
        if (isMalformedToolCall(e) && attempt < MAX_RESAMPLES) {
          console.warn(`[agent-loop] ${model} produced an invalid tool call (turn ${turn}, attempt ${attempt + 1}); re-sampling`);
          continue;
        }
        throw explainLlmError(e, role, model);
      }
    }

    const message = response.choices[0]?.message;
    if (!message) throw new Error(`Agent loop: ${model} returned no message on turn ${turn}`);

    const calls = (message.tool_calls ?? []).filter((c) => c.type === "function");
    if (calls.length === 0) {
      throw new Error(`Agent loop: ${model} produced no tool call on turn ${turn} (instructions require calling ${submissionToolName}); content was: ${message.content}`);
    }

    // Echo back only the fields the API needs — provider extras (e.g. a `reasoning` field) are not re-sent.
    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });

    const submissionCall = calls.find((c) => c.function.name === submissionToolName);
    if (submissionCall) {
      const args = parseArgs(submissionToolName, submissionCall.function.arguments);
      toolCalls.push({ name: submissionToolName, args, rawResult: args, resultHash: hashJson(args) });
      return { submission: args as TSubmission, toolCalls, turns: turn + 1, model };
    }

    for (const call of calls) {
      const args = parseArgs(call.function.name, call.function.arguments);
      const result = await executeTool(call.function.name, args);
      toolCalls.push({ name: call.function.name, args, rawResult: result, resultHash: hashJson(result) });
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  throw new Error(`Agent loop exceeded maxTurns (${maxTurns}) without a call to ${submissionToolName}`);
}
