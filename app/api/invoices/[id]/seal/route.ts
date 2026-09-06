import { getDecisionsForInvoice, toChainableRecord } from "@/lib/ledger/decisions";
import { computeHash } from "@/lib/ledger/hash-chain";

/**
 * POST /api/invoices/:id/seal — the frontend's "cryptographic seal" metaphor for "this
 * invoice's decision trail is genuinely tamper-evident." Real check, not theater: for each of
 * this invoice's own decisions, recomputes computeHash(storedPrevHash, hashableRow(d)) and
 * confirms it equals the stored hash — a real per-record integrity check. Deliberately NOT
 * the same as verifyChain() (that walks the GLOBAL chain with its own running prevHash; this
 * invoice's decisions are interleaved with every other invoice's in the real global sequence,
 * so checking them in isolation with a locally-tracked prev would be checking the wrong thing).
 * No new "sealed" column exists — nothing is persisted here, this is a verification action,
 * not a state change.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const decisions = await getDecisionsForInvoice(id);
  if (decisions.length === 0) return Response.json({ error: `no invoice found with id '${id}'` }, { status: 404 });

  for (const d of decisions) {
    const record = toChainableRecord(d);
    const expected = computeHash(d.prevHash ?? null, record);
    if (expected !== d.hash) {
      return Response.json({ success: false, sealed: false, brokenAt: d.id }, { status: 409 });
    }
  }

  const latest = decisions[decisions.length - 1];
  return Response.json({ success: true, sealed: true, id, hash: latest.hash, decisionsVerified: decisions.length });
}
