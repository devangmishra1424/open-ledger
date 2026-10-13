import { getSql } from "@/db/client";
import { handle } from "@/lib/http";
import { verifyInvoiceTrail } from "@/lib/ledger/trail";

/**
 * POST /api/audit/seal-all — the same per-invoice trail check as POST /api/invoices/:id/seal (content
 * plus both chain links, lib/ledger/trail.ts), across every invoice GET /api/audit/seals lists as
 * ready. A real check over each of them, not a count returned on faith.
 */
export const POST = handle("POST /api/audit/seal-all", async () => {
  const rows = await getSql()`SELECT id FROM vendor_bills WHERE status IN ('approved', 'posted') ORDER BY received_at DESC`;
  let sealedCount = 0;
  const failedIds: string[] = [];
  for (const row of rows) {
    const result = await verifyInvoiceTrail(row.id);
    if (result && !result.valid) failedIds.push(row.id);
    else sealedCount++;
  }
  return Response.json({ success: failedIds.length === 0, sealedCount, failedIds });
});
