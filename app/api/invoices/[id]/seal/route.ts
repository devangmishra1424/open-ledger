import { handle } from "@/lib/http";
import { TRAIL_BREAK_WORDS, verifyInvoiceTrail } from "@/lib/ledger/trail";

/**
 * POST /api/invoices/:id/seal — "is this invoice's decision trail intact?" A verification action, not
 * a state change: nothing is persisted. Each of the invoice's records is checked for its own content
 * AND for its links to the records on either side of it in the global chain (lib/ledger/trail.ts), so
 * a record that was edited and then re-hashed is caught here too, not only by GET /api/audit/verify.
 *
 * 200 { sealed: true, hash, decisionsVerified } | 409 { sealed: false, brokenAt, reason, error } | 404.
 */
export const POST = handle("POST /api/invoices/:id/seal", async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const result = await verifyInvoiceTrail(id);
  if (!result) return Response.json({ error: `no invoice found with id '${id}'` }, { status: 404 });
  if (!result.valid) {
    return Response.json(
      { success: false, sealed: false, brokenAt: result.brokenAt, reason: result.reason, error: `A record was altered: ${TRAIL_BREAK_WORDS[result.reason!]}.` },
      { status: 409 },
    );
  }
  return Response.json({ success: true, sealed: true, id, hash: result.latestHash, decisionsVerified: result.checked });
});
