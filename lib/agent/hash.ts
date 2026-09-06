import crypto from "node:crypto";
import stableStringify from "fast-json-stable-stringify";

/** Deterministic hash of a tool call's result, for ToolCallLog.resultHash (lib/types.ts). */
export function hashJson(value: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}
