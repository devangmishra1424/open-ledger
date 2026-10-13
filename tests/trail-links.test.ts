import { describe, it, expect } from "vitest";
import { computeHash, type ChainableRecord } from "@/lib/ledger/hash-chain";
import { checkTrailLinks, type TrailLink } from "@/lib/ledger/trail";

/**
 * Per-invoice trail verification (POST /api/invoices/:id/seal). A global chain a1 -> b1 -> a2 -> b2,
 * where invoice A owns a1 and a2 and invoice B owns b1 and b2: A's records are checked against their
 * neighbours in the whole chain, which belong to B.
 */
function record(id: string, action: string, prevHash: string | null): ChainableRecord {
  const r = { id, action_taken: action, prevHash, hash: "" };
  r.hash = computeHash(prevHash, r);
  return r as ChainableRecord;
}

function chain() {
  const a1 = record("a1", "extracted", null);
  const b1 = record("b1", "extracted", a1.hash);
  const a2 = record("a2", "auto_approve", b1.hash);
  const b2 = record("b2", "auto_approve", a2.hash);
  return { a1, b1, a2, b2 };
}

/** Invoice A's view: each of its records with the global neighbours on either side. */
function linksForA(all: ChainableRecord[], aIds = ["a1", "a2"]): TrailLink[] {
  return aIds.map((id) => {
    const i = all.findIndex((r) => r.id === id);
    return { record: all[i], predecessorHash: i > 0 ? all[i - 1].hash : null, successorPrevHash: i < all.length - 1 ? all[i + 1].prevHash : undefined };
  });
}

describe("per-invoice trail verification", () => {
  it("an untouched trail verifies, including its first record (no predecessor) and the newest (no successor)", () => {
    const { a1, b1, a2, b2 } = chain();
    expect(checkTrailLinks(linksForA([a1, b1, a2, b2]))).toEqual({ valid: true, checked: 2 });
    expect(checkTrailLinks(linksForA([a1, b1, a2], ["a1", "a2"]))).toEqual({ valid: true, checked: 2 });
  });

  it("an edited record whose hash was left alone is caught on its content", () => {
    const { a1, b1, a2, b2 } = chain();
    const edited = { ...a2, action_taken: "block" };
    expect(checkTrailLinks(linksForA([a1, b1, edited, b2]))).toMatchObject({ valid: false, brokenAt: "a2", reason: "content" });
  });

  it("regression: an edited record that was RE-HASHED is caught, because the next record no longer points at it", () => {
    // The old per-invoice check recomputed each record from its own stored prev_hash only, so this passed.
    const { a1, b1, a2, b2 } = chain();
    const forged = { ...a2, action_taken: "block" };
    forged.hash = computeHash(forged.prevHash, forged);
    expect(checkTrailLinks(linksForA([a1, b1, forged, b2]))).toMatchObject({ valid: false, brokenAt: "a2", reason: "link_after" });
  });

  it("a record removed between two of the invoice's records is caught: the earlier one's successor no longer points at it", () => {
    const { a1, a2, b2 } = chain(); // b1 deleted
    expect(checkTrailLinks(linksForA([a1, a2, b2]))).toMatchObject({ valid: false, brokenAt: "a1", reason: "link_after" });
  });

  it("a record inserted in front of the invoice's record is caught on the backward link", () => {
    const { a1, b1, a2, b2 } = chain();
    const inserted = record("x", "auto_approve", b1.hash);
    expect(checkTrailLinks(linksForA([a1, b1, inserted, a2, b2], ["a2"]))).toMatchObject({ valid: false, brokenAt: "a2", reason: "link_before" });
  });

  it("a whole forged tail rewritten consistently from the invoice's record onward is still caught at the first untouched neighbour", () => {
    const { a1, b1, a2 } = chain();
    const forged = { ...a2, action_taken: "block" };
    forged.hash = computeHash(forged.prevHash, forged);
    const b2 = record("b2", "auto_approve", a2.hash); // the untouched next record still points at the original
    expect(checkTrailLinks(linksForA([a1, b1, forged, b2])).valid).toBe(false);
  });
});
