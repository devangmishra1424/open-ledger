import { llmConfigured } from "@/lib/agent/llm";

/**
 * Suites that call the real model provider cost real quota (the free tier caps a model at 200k
 * tokens a day, and a full run uses a good share of it) and cannot run without a key. They run
 * when a key is configured, and are SKIPPED — visibly, in the report — otherwise, or when
 * SKIP_LIVE_LLM=1 is set to run only the deterministic suites.
 */
export const liveLlm = llmConfigured() && !process.env.SKIP_LIVE_LLM;
