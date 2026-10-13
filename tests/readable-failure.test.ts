import { describe, it, expect } from "vitest";
import { readableAgentFailure } from "@/lib/agent/llm";

describe("a recorded AI failure, worded for the screen", () => {
  it("regression: the provider's raw 429 text (with its account id) becomes the plain sentence new failures already get", () => {
    const raw = "429 Rate limit reached for model `openai/gpt-oss-120b` in organization `org_01kkd6gpkpenrtstqbf1sh19pm` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199500, Requested 1200. Please try again in 5m2.4s.";
    const shown = readableAgentFailure(raw);
    expect(shown).toBe("The AI provider's daily usage limit for openai/gpt-oss-120b was reached; it says to try again in 5m2.4s. This is a quota on the provider's free tier, not a fault with the invoice.");
    expect(shown).not.toMatch(/org_/);
  });

  it("any other failure keeps its wording, with a provider account id masked", () => {
    expect(readableAgentFailure("Request failed for organization org_ABC123 after 4 retries")).toBe("Request failed for organization [provider account] after 4 retries");
    expect(readableAgentFailure("Investigator returned no conclusion")).toBe("Investigator returned no conclusion");
  });
});
