import crypto from "node:crypto";
import stableStringify from "fast-json-stable-stringify";

/**
 * Deterministic canonicalization per ALGORITHMS.md §2: same logical record always
 * produces the same string regardless of key insertion order.
 *
 * Two fields are excluded from the hashed payload, both deliberately, not by oversight:
 * - `hash` itself — it's the output of this computation, not an input.
 * - `superseded_by_id` — this is the ONE field on a `decisions` row that legitimately
 *   changes after the row is written (set later by markSuperseded(), when a reconsideration
 *   supersedes this decision). If it were included, verifyChain() would recompute a
 *   different hash after that update than the one stored at write time, and every
 *   superseded decision would show as a broken chain — a real bug, caught by tracing
 *   through it by hand before this shipped, not a hypothetical. Every other field on the
 *   row is genuinely immutable after insert (enforced by writeDecision() never issuing an
 *   UPDATE for anything else), so excluding only this one field is a narrow, deliberate
 *   exception, not a loophole — the decision's actual content (what it decided, on what
 *   evidence, with what confidence) is still fully tamper-evident.
 */
export function canonicalize(record: Record<string, unknown>): string {
  const { hash: _hash, superseded_by_id: _supersededById, ...rest } = record;
  return stableStringify(rest);
}

export function computeHash(prevHash: string | null, record: Record<string, unknown>): string {
  const payload = (prevHash ?? "GENESIS") + "|" + canonicalize(record);
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export interface ChainableRecord {
  id: string;
  prevHash: string | null;
  hash: string;
  [key: string]: unknown;
}

export interface ChainVerifyResult {
  valid: boolean;
  brokenAt?: string;
  checked: number;
}

/** Recomputes the chain from scratch every time — never trusts a cached "valid" flag. */
export function verifyChain(recordsInInsertOrder: ChainableRecord[]): ChainVerifyResult {
  let prev: string | null = null;
  for (const record of recordsInInsertOrder) {
    const expected = computeHash(prev, record);
    if (expected !== record.hash) {
      return { valid: false, brokenAt: record.id, checked: recordsInInsertOrder.length };
    }
    prev = record.hash;
  }
  return { valid: true, checked: recordsInInsertOrder.length };
}
