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

/**
 * Reasoning models (gpt-oss) think before answering, and those reasoning tokens count against the
 * provider's tokens-per-minute cap and add seconds of latency. These agents do bounded
 * tool-driven lookups, not open-ended reasoning, so "low" is the right default; override with
 * LLM_REASONING_EFFORT (low | medium | high). Models without this knob get nothing sent.
 */
export function reasoningEffortFor(model: string): "low" | "medium" | "high" | undefined {
  if (!model.startsWith("openai/gpt-oss")) return undefined;
  const v = process.env.LLM_REASONING_EFFORT?.trim().toLowerCase();
  return v === "low" || v === "medium" || v === "high" ? v : "low";
}

/** True when an LLM provider key is configured (callers that can degrade check this first). */
export function llmConfigured(): boolean {
  return Boolean(process.env.GROQ_API_KEY);
}

/**
 * Models report confidence on different scales for the same schema field: 0.97, 97, even 100
 * (observed from gpt-oss-20b in a benchmark run). Everything downstream assumes 0-1, so
 * normalise at the boundary. Anything unusable becomes 0 — a missing or garbled confidence
 * must never read as certainty.
 */
export function normalizeConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n > 1 && n <= 100) return n / 100;
  return Math.min(n, 1);
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

/** The provider is refusing requests for now because a usage cap was hit (HTTP 429, after the SDK's own bounded retries). */
export class LlmRateLimitError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlmRateLimitError";
  }
}

/** Turns the provider's 429 text ("... on tokens per day (TPD) ... try again in 2m55s") into a sentence a person can act on. */
export function describeRateLimit(model: string, providerMessage: string): string {
  const daily = /per day|\bTPD\b|\bRPD\b/i.test(providerMessage);
  const retry = providerMessage.match(/try again in ([0-9hms.]+)/i)?.[1]?.replace(/\.$/, ""); // the sentence's own full stop is not part of the duration
  return `The AI provider's ${daily ? "daily" : "per-minute"} usage limit for ${model} was reached${retry ? `; it says to try again in ${retry}` : ""}. This is a quota on the provider's free tier, not a fault with the invoice.`;
}

/**
 * The model itself produced an invalid tool call (e.g. gpt-oss occasionally emits a call to a
 * made-up tool such as "commentary", or answers in prose when a tool call is required) and the
 * provider rejected the response with HTTP 400.
 * The REQUEST was fine — this is non-deterministic model output, so asking again is a different
 * outcome, unlike a normal 4xx. Callers re-sample a bounded number of times (see loop.ts).
 */
export function isMalformedToolCall(err: unknown): boolean {
  return err instanceof OpenAI.APIError && err.status === 400
    && /tool call validation failed|failed to call a function|tool_use_failed|tool choice is required, but model did not call a tool|model generated output that could not be parsed|failed_generation/i.test(err.message);
}

/**
 * Re-throws provider errors that are really configuration problems with a message that says
 * what to change. Everything else (timeouts, 429, 5xx, malformed output) passes through
 * unchanged so callers see the real failure.
 */
export function explainLlmError(err: unknown, role: AgentRole, model: string): unknown {
  if (err instanceof OpenAI.APIError) {
    if (err.status === 429) {
      return new LlmRateLimitError(describeRateLimit(model, err.message), { cause: err });
    }
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
