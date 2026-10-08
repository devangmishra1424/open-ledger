import OpenAI from "openai";
import type { ToolCallLog } from "@/lib/types";
import type { ToolDef } from "@/lib/agent/tools";
import { hashJson } from "@/lib/agent/hash";

const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const TIMEOUT_MS = 20_000;
const MAX_RETRIES = 1;

let client: OpenAI | undefined;
function getGroqClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY is not set");
    client = new OpenAI({ apiKey, baseURL: "https://api.groq.com/openai/v1" });
  }
  return client;
}

function toChatCompletionTool(toolDef: ToolDef): OpenAI.Chat.ChatCompletionTool {
  return {
    type: "function",
    function: { name: toolDef.name, description: toolDef.description ?? undefined, parameters: toolDef.parameters ?? undefined },
  };
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
  maxTurns?: number;
}

export async function runResponsesLoop<TSubmission>(params: RunResponsesLoopParams<TSubmission>): Promise<AgentLoopResult<TSubmission>> {
  const { model = DEFAULT_MODEL, instructions, initialInput, tools, submissionToolName, executeTool, maxTurns = 8 } = params;
  const openai = getGroqClient();
  const chatTools = tools.map(toChatCompletionTool);

  let messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: instructions },
    { role: "user", content: initialInput }
  ];
  const toolCalls: ToolCallLog[] = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await openai.chat.completions.create(
      { model, messages, tools: chatTools },
      { timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES },
    );

    const message = response.choices[0]?.message;
    if (!message) throw new Error(`Agent loop: Groq returned no message on turn ${turn}`);

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      throw new Error(`Agent loop: model produced no function call on turn ${turn} (instructions require calling ${submissionToolName}); output_text was: ${message.content}`);
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
