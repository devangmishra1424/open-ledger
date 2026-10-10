import { getSql } from "@/db/client";
import { getAllDecisionsInOrder, toChainableRecord } from "@/lib/ledger/decisions";
import { verifyChain, type ChainVerifyResult } from "@/lib/ledger/hash-chain";

/**
 * Whole-chain verification for status displays (dashboard, audit page, API).
 *
 * Verifying recomputes every hash from genesis — O(n) — and the screens poll. So the result is
 * cached, but never trusted blindly: it is reused only while the chain has the same length and
 * newest sequence number AND is younger than MAX_AGE_MS, so appended decisions show up at once
 * and an in-place edit of an old row is still caught within MAX_AGE_MS. Everything that must be
 * authoritative (POST /api/invoices/:id/seal, GET /api/audit/verify) calls verifyChain directly.
 */
const MAX_AGE_MS = 30_000;

let cache: { key: string; at: number; result: ChainVerifyResult } | undefined;

export async function getChainStatus(now = Date.now()): Promise<ChainVerifyResult & { cached: boolean }> {
  const [tip] = await getSql()`SELECT COALESCE(MAX(seq), 0)::text AS max_seq, COUNT(*)::int AS n FROM decisions`;
  const key = `${tip.max_seq}:${tip.n}`;
  if (cache && cache.key === key && now - cache.at < MAX_AGE_MS) return { ...cache.result, cached: true };
  const result = verifyChain((await getAllDecisionsInOrder()).map(toChainableRecord));
  cache = { key, at: now, result };
  return { ...result, cached: false };
}

/** Test hook. */
export function resetChainStatusCache(): void {
  cache = undefined;
}
