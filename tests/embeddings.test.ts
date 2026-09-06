import { describe, it, expect } from "vitest";
import { getEmbedding, cosineSimilarity } from "@/lib/embeddings";

describe("cosineSimilarity — pure math, no API call", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("is scale-invariant", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it("computes a known non-trivial similarity", () => {
    // dot = 1*4 + 2*5 + 3*6 = 32; |a| = sqrt(14); |b| = sqrt(77)
    // 32 / (sqrt(14) * sqrt(77)) = 32 / sqrt(1078) ≈ 0.9746318...
    expect(cosineSimilarity([1, 2, 3], [4, 5, 6])).toBeCloseTo(0.9746318461970762, 10);
  });

  it("throws on mismatched lengths", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/length mismatch/);
  });

  it("throws on a zero vector, which has no defined direction", () => {
    expect(() => cosineSimilarity([0, 0], [1, 2])).toThrow(/zero vector/);
  });
});

/**
 * Real call against the live OpenAI embeddings API — this project's testing standard is
 * zero mocks (see tests/extractor.test.ts), so this proves the actual wire call and
 * response-shape parsing, not just type compatibility.
 */
describe("getEmbedding() — real OpenAI embeddings API call", () => {
  it("embeds similar sentences closer together than unrelated ones", async () => {
    const [invoiceMismatch, billMismatch, catOnWindowsill] = await Promise.all([
      getEmbedding("The invoice total does not match the purchase order amount."),
      getEmbedding("The bill's total differs from the PO's stated amount."),
      getEmbedding("The cat sat quietly on the warm windowsill in the afternoon sun."),
    ]);

    expect(invoiceMismatch).toHaveLength(1536); // text-embedding-3-small's native dimensionality
    expect(billMismatch).toHaveLength(1536);

    const similar = cosineSimilarity(invoiceMismatch, billMismatch);
    const unrelated = cosineSimilarity(invoiceMismatch, catOnWindowsill);

    expect(similar).toBeGreaterThan(0.5);
    expect(unrelated).toBeLessThan(similar);
  }, 30_000);
});
