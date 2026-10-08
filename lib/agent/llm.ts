import OpenAI from "openai";

/**
 * The one place that knows which provider and which models the agents use.
 *
 * Provider: Groq's OpenAI-compatible endpoint (Chat Completions), via the OpenAI SDK.
 *
 * Models are per ROLE and overridable by env var, because hosted model ids get retired without
 * notice — `llama-3.3-70b-versatile` (the original hard-coded id) was retired and every
 * Investigator/Verifier/Ask-Why call started returning 404. With the id in an env var that is a
 * config change, not a code change, and the error below names the variable to change.
 *
 * Investigator and Verifier default to DIFFERENT model families (OpenAI gpt-oss vs Alibaba
 * Qwen). The Verifier is sold as an independent second opinion; the same model checking its
 * own reasoning is not independent.
 */
export type AgentRole = "extractor" | "investigator" | "verifier" | "explainer";

const DEFAULT_MODELS: Record<AgentRole, string> = {
  extractor: "openai/gpt-oss-120b",
  investigator: "openai/gpt-oss-120b",
  verifier: "qwen/qwen3.8-27b",
  explainer: "openai/gpt-oss-120b",
};

const ENV_VAR: Record<AgentRole, string> = {
  extractor: "EXTRACTOR_MODEL",
  investigator: "INVESTIGATOR_MODEL",
  verifier: "VERIFIER_MODEL",
  explainer: "EXPLAIN_MODEL",
};

export function modelFor(role: AgentRole): string {
  return process.env[ENV_VAR[role]]?.trim() || DEFAULT_MODELS[role];
}

/** True when an LLM provider key is configured (callers that can degrade check this first). */
export function llmConfigured(): boolean {
  return Boolean(process.env.GROQ_API_KEY);
}

let client: OpenAI | undefined;
export function getLlmClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new LlmConfigError("GROQ_API_KEY is not set");
    client = new OpenAI({ apiKey, baseURL: "https://api.groq.com/openai/v1" });
  }
  return client;
}

/** A provider-side problem the operator can fix by changing configuration (key or model id). */
export class LlmConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlmConfigError";
  }
}

/**
 * The model itself produced an invalid tool call (e.g. gpt-oss occasionally emits a call to a
 * made-up tool such as "commentary") and the provider rejected the response with HTTP 400.
 * The REQUEST was fine — this is non-deterministic model output, so asking again is a different
 * outcome, unlike a normal 4xx. Callers re-sample a bounded number of times (see loop.ts).
 */
export function isMalformedToolCall(err: unknown): boolean {
  return err instanceof OpenAI.APIError && err.status === 400 && /tool call validation failed|failed to call a function|tool_use_failed/i.test(err.message);
}

/**
 * Re-throws provider errors that are really configuration problems with a message that says
 * what to change. Everything else (timeouts, 429, 5xx, malformed output) passes through
 * unchanged so callers see the real failure.
 */
export function explainLlmError(err: unknown, role: AgentRole, model: string): unknown {
  if (err instanceof OpenAI.APIError) {
    if (err.status === 401) {
      return new LlmConfigError(`The LLM provider rejected GROQ_API_KEY (HTTP 401).`, { cause: err });
    }
    if (err.status === 404) {
      return new LlmConfigError(
        `Model '${model}' is not available from the LLM provider (HTTP 404) — set ${ENV_VAR[role]} to a model your key can use.`,
        { cause: err },
      );
    }
  }
  return err;
}
