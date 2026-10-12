import { describe, it, expect } from "vitest";
import { attestationLabels } from "@/lib/pbc-shapes";

describe("audit evidence: who stood behind each step (attestationLabels)", () => {
  it("says rules for deterministic code, AI for a model, person for a human, once per stage", () => {
    const labels = attestationLabels([
      { node_id: "extract", agent_id: "deterministic-parser", action_taken: "parsed" },
      { node_id: "validate", agent_id: "deterministic-validator", action_taken: "pass" },
      { node_id: "match", agent_id: "deterministic-matching-engine", action_taken: "escalate_l1" },
      { node_id: "investigate", agent_id: "openai/gpt-oss-120b", action_taken: "escalate_l1" },
      { node_id: "policy", agent_id: "deterministic-policy-engine", action_taken: "escalate_l1" },
      { node_id: "human_review", agent_id: "Priya Shah", action_taken: "human_approved" },
      { node_id: "human_review", agent_id: "Sam Lee", action_taken: "human_approved" },
      { node_id: "audit", agent_id: "system", action_taken: "error" },
    ]);
    expect(labels).toEqual(["Read (rules)", "Gates (rules)", "Match (rules)", "Investigator (AI)", "Policy (rules)", "Reviewer (person)", "Record (rules)"]);
  });
  it("never calls the rule engine an agent, and skips steps that recorded no action", () => {
    const labels = attestationLabels([
      { node_id: "match", agent_id: "deterministic-matching-engine", action_taken: "auto_approve" },
      { node_id: "verify", agent_id: "qwen/qwen3", action_taken: null },
    ]);
    expect(labels).toEqual(["Match (rules)"]);
    expect(labels.join(" ")).not.toMatch(/Agent/);
  });
});
