import { getChainStatus } from "@/lib/ledger/chain-status";
import { llmConfigured, modelFor } from "@/lib/agent/llm";
import { handle } from "@/lib/http";

/**
 * GET /api/system — what this deployment is actually doing, in one place, so the UI can say it
 * instead of implying it. Contains no secrets: only whether keys are present, and model ids.
 */
export const GET = handle("GET /api/system", async () => {
  const chain = await getChainStatus();
  return Response.json({
    llm: {
      configured: llmConfigured(),
      provider: "Groq (OpenAI-compatible)",
      models: {
        extractor: modelFor("extractor"),
        investigator: modelFor("investigator"),
        verifier: modelFor("verifier"),
        explainer: modelFor("explainer"),
      },
    },
    // Payments are recorded and posted to the ledger, but no money moves (lib/payments/payments.ts).
    paymentRail: { mode: "simulated" },
    // Vendor callbacks are made by a person; no automated voice call is placed (lib/voice.ts).
    callbacks: { mode: "manual" },
    // Reviewer names are self-declared; there is no login yet.
    authentication: { mode: "none" },
    chain: { valid: chain.valid, checked: chain.checked, brokenAt: chain.brokenAt ?? null },
  });
});
