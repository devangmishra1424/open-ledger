import { getInvoiceTrailWithNeighbours, toChainableRecord } from "@/lib/ledger/decisions";
import { computeHash, type ChainableRecord } from "@/lib/ledger/hash-chain";

/**
 * Verifying ONE invoice's trail (POST /api/invoices/:id/seal and /api/audit/seal-all).
 *
 * The chain is global: an invoice's records are interleaved with everyone else's. The old check
 * recomputed each record's hash from its own stored prev_hash, which proves the record's content
 * matches its hash and nothing more. Someone who edited a record AND recomputed its hash passed it
 * (the whole-chain check, /api/audit/verify, still caught them: the next record no longer pointed at
 * the edited one). So each record is now also checked against its neighbours in the global chain:
 *
 *   content      hash == computeHash(stored prev_hash, record)       the record says what it hashed
 *   link_before  stored prev_hash == hash of the record just before   nothing removed or swapped in front
 *   link_after   prev_hash of the record just after == this hash      nothing rewritten and re-hashed, nothing removed after
 *
 * That is everything a single invoice can prove locally; tampering with OTHER invoices' records far
 * from this one is the whole-chain check's job.
 */

export type TrailBreak = "content" | "link_before" | "link_after";

export interface TrailLink {
  record: ChainableRecord;
  /** Hash of the record immediately before this one in the global chain; null when this is the first record. */
  predecessorHash: string | null;
  /** prev_hash of the record immediately after this one; undefined when this is the newest record of all. */
  successorPrevHash: string | null | undefined;
}

export interface TrailVerifyResult {
  valid: boolean;
  checked: number;
  brokenAt?: string;
  reason?: TrailBreak;
}

/** Pure: checks each record's content and both of its links, in order, and stops at the first break. */
export function checkTrailLinks(links: TrailLink[]): TrailVerifyResult {
  for (const { record, predecessorHash, successorPrevHash } of links) {
    if (computeHash(record.prevHash ?? null, record) !== record.hash) return { valid: false, checked: links.length, brokenAt: record.id, reason: "content" };
    if ((record.prevHash ?? null) !== predecessorHash) return { valid: false, checked: links.length, brokenAt: record.id, reason: "link_before" };
    if (successorPrevHash !== undefined && successorPrevHash !== record.hash) return { valid: false, checked: links.length, brokenAt: record.id, reason: "link_after" };
  }
  return { valid: true, checked: links.length };
}

export const TRAIL_BREAK_WORDS: Record<TrailBreak, string> = {
  content: "its content no longer matches its hash",
  link_before: "it no longer points at the record before it, so something before it was changed, removed or inserted",
  link_after: "the record after it no longer points at it, so it was rewritten and re-hashed, or a record after it was removed",
};

/** Null when the invoice has no recorded decisions at all. */
export async function verifyInvoiceTrail(invoiceId: string): Promise<(TrailVerifyResult & { latestHash: string }) | null> {
  const trail = await getInvoiceTrailWithNeighbours(invoiceId);
  if (trail.length === 0) return null;
  const result = checkTrailLinks(trail.map((t) => ({ record: toChainableRecord(t.decision), predecessorHash: t.predecessorHash, successorPrevHash: t.successorPrevHash })));
  return { ...result, latestHash: trail[trail.length - 1].decision.hash };
}
