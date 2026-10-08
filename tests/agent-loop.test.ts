import { describe, it, expect, vi } from "vitest";
import OpenAI from "openai";
import { runToolLoop } from "@/lib/agent/loop";
import { LlmConfigError, isMalformedToolCall, modelFor } from "@/lib/agent/llm";

/**
 * The tool loop against a fake provider client — no network. Pins the behaviours that matter
 * when the real model misbehaves: bad tool calls, bad JSON, a retired model id, runaway loops.
 */

const SUBMIT = { name: "submit_x", description: "submit", parameters: { type: "object", properties: {}, additionalProperties: false } } as any;
const LOOKUP = { name: "lookup", description: "lookup", parameters: { type: "object", properties: {}, additionalProperties: false } } as any;

function toolCallMessage(name: string, args: unknown, id = "call_1") {
  return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } }] } }] };
}

function fakeClient(responses: Array<unknown | Error>) {
  // The loop mutates one messages array across turns, so snapshot what each request actually carried.
  const sent: any[][] = [];
  const create = vi.fn(async (req: any) => {
    sent.push(structuredClone(req.messages));
    const next = responses.shift();
    if (next === undefined) throw new Error("fake client ran out of responses");
    if (next instanceof Error) throw next;
    return next;
  });
  return { client: { chat: { completions: { create } } } as any, create, sent };
}

const base = { role: "investigator" as const, instructions: "sys", initialInput: "in", tools: [LOOKUP, SUBMIT], submissionToolName: "submit_x", executeTool: async () => ({ ok: true }) };

function apiError(status: number, message: string) {
  return new OpenAI.APIError(status, { message }, message, new Headers());
}

describe("runToolLoop", () => {
  it("runs an evidence tool, feeds the result back, and returns the submission with the model that produced it", async () => {
    const { client, sent } = fakeClient([toolCallMessage("lookup", { q: 1 }), toolCallMessage("submit_x", { answer: 42 }, "call_2")]);
    const executeTool = vi.fn(async () => ({ vendor: "Acme" }));
    const r = await runToolLoop<{ answer: number }>({ ...base, client, executeTool, model: "test-model" });
    expect(r.submission).toEqual({ answer: 42 });
    expect(r.model).toBe("test-model");
    expect(r.turns).toBe(2);
    expect(r.toolCalls.map((c) => c.name)).toEqual(["lookup", "submit_x"]);
    expect(executeTool).toHaveBeenCalledWith("lookup", { q: 1 });
    // the second request carried the tool result back to the model
    expect(sent[1].at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_1", content: JSON.stringify({ vendor: "Acme" }) });
  });

  it("demands a tool call every turn", async () => {
    const { client, create } = fakeClient([toolCallMessage("submit_x", {})]);
    await runToolLoop({ ...base, client });
    expect((create.mock.calls[0] as any[])[0].tool_choice).toBe("required");
  });

  it("re-samples when the model emits an invalid tool call, then succeeds", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = apiError(400, "Tool call validation failed: attempted to call tool 'commentary' which was not in request.tools");
    const { client, create } = fakeClient([bad, toolCallMessage("submit_x", { ok: true })]);
    const r = await runToolLoop<{ ok: boolean }>({ ...base, client });
    expect(r.submission.ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("gives up after two re-samples instead of looping forever", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = () => apiError(400, "Tool call validation failed: attempted to call tool 'commentary'");
    const { client, create } = fakeClient([bad(), bad(), bad(), toolCallMessage("submit_x", {})]);
    await expect(runToolLoop({ ...base, client })).rejects.toThrow(/Tool call validation failed/);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry an ordinary 400 (a genuinely bad request)", async () => {
    const { client, create } = fakeClient([apiError(400, "max_tokens is too large"), toolCallMessage("submit_x", {})]);
    await expect(runToolLoop({ ...base, client })).rejects.toThrow(/max_tokens/);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("turns a 404 (retired model id) into a config error that names the env var to change", async () => {
    const { client } = fakeClient([apiError(404, "The model `old-model` does not exist")]);
    const err = await runToolLoop({ ...base, client, role: "verifier", model: "old-model" }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmConfigError);
    expect(err.message).toContain("old-model");
    expect(err.message).toContain("VERIFIER_MODEL");
  });

  it("fails loudly when the model answers in prose instead of calling a tool", async () => {
    const { client } = fakeClient([{ choices: [{ message: { role: "assistant", content: "Could you clarify?" } }] }]);
    await expect(runToolLoop({ ...base, client })).rejects.toThrow(/produced no tool call/);
  });

  it("fails loudly on malformed tool arguments instead of guessing", async () => {
    const { client } = fakeClient([toolCallMessage("submit_x", "{not json")]);
    await expect(runToolLoop({ ...base, client })).rejects.toThrow(/malformed arguments for tool 'submit_x'/);
  });

  it("stops at maxTurns when the model only ever calls evidence tools", async () => {
    const { client, create } = fakeClient([toolCallMessage("lookup", {}), toolCallMessage("lookup", {}, "c2"), toolCallMessage("lookup", {}, "c3")]);
    await expect(runToolLoop({ ...base, client, maxTurns: 3 })).rejects.toThrow(/exceeded maxTurns \(3\)/);
    expect(create).toHaveBeenCalledTimes(3);
  });
});

describe("model configuration", () => {
  it("defaults the Investigator and Verifier to different model families", () => {
    expect(modelFor("investigator")).not.toBe(modelFor("verifier"));
  });
  it("is overridable per role by env var", () => {
    vi.stubEnv("VERIFIER_MODEL", "some/other-model");
    expect(modelFor("verifier")).toBe("some/other-model");
    vi.unstubAllEnvs();
  });
  it("classifies only provider rejections of the model's own tool call as malformed-tool-call", () => {
    expect(isMalformedToolCall(apiError(400, "Tool call validation failed: x"))).toBe(true);
    expect(isMalformedToolCall(apiError(400, "unrelated"))).toBe(false);
    expect(isMalformedToolCall(apiError(500, "Tool call validation failed"))).toBe(false);
    expect(isMalformedToolCall(new Error("Tool call validation failed"))).toBe(false);
  });
});
