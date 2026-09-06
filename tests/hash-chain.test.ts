import { describe, it, expect } from "vitest";
import { computeHash, verifyChain, type ChainableRecord } from "@/lib/ledger/hash-chain";

/**
 * Records must include `prevHash` as a field from the moment the hash is first computed —
 * matching how the real `decisions` table works (`prev_hash` is a stored column, present in
 * the row both when `writeDecision()` computes the hash and later when `verifyChain()` reads
 * it back). Building a record WITHOUT `prevHash` and adding it only at verification time
 * silently changes the canonicalized payload and was a real bug in an earlier draft of this
 * test file — caught by the first run of these tests actually failing.
 */
function makeRecord(id: string, actionTaken: string, prevHash: string | null, supersededById: string | null = null): ChainableRecord {
  const base = { id, action_taken: actionTaken, superseded_by_id: supersededById, prevHash, hash: "" };
  base.hash = computeHash(prevHash, base);
  return base as ChainableRecord;
}

describe("hash-chain", () => {
  it("a chain of untouched records verifies as valid", () => {
    const r1 = makeRecord("d1", "auto_approve", null);
    const r2 = makeRecord("d2", "escalate_l1", r1.hash);

    const result = verifyChain([r1, r2]);
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(2);
  });

  it("regression: setting superseded_by_id AFTER write must not break verification", () => {
    // The exact bug caught during development: markSuperseded() issues an UPDATE on
    // superseded_by_id after the row is written. If that field were part of the hashed
    // payload, this would falsely report a broken chain on every superseded decision.
    const r1 = makeRecord("d1", "auto_approve", null);
    const afterSupersede: ChainableRecord = { ...r1, superseded_by_id: "d2" };

    const result = verifyChain([afterSupersede]);
    expect(result.valid).toBe(true);
  });

  it("genuine tampering with a decision's real content is still detected", () => {
    const r1 = makeRecord("d1", "auto_approve", null);
    const tampered: ChainableRecord = { ...r1, action_taken: "block" }; // hash left as-is, content changed

    const result = verifyChain([tampered]);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe("d1");
  });

  it("a broken link partway through the chain is caught, not just the first record", () => {
    const r1 = makeRecord("d1", "a", null);
    const r2 = makeRecord("d2", "b", r1.hash);
    const r3 = makeRecord("d3", "c", r2.hash);

    const withTamperedMiddle = [r1, { ...r2, action_taken: "TAMPERED" }, r3];

    const result = verifyChain(withTamperedMiddle);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe("d2");
  });
});
