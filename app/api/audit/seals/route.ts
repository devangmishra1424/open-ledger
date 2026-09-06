import { getSql } from "@/db/client";
import { getFrontendInvoice } from "@/lib/api-shapes";

/**
 * GET /api/audit/seals — the frontend's `mockPendingSeals` shape: `{id, vendor, amount,
 * confidence}[]`. Sealing (POST /api/invoices/:id/seal) is a stateless hash-integrity check —
 * nothing persists a "sealed" flag (see that route's own comment) — so "pending" is defined
 * here as: invoices whose pipeline has resolved cleanly (posted/approved) and are therefore
 * ready to have their chain committed/verified, as opposed to still-processing or already-void
 * ones. A real, derived definition, not a fabricated list.
 */
export async function GET() {
  const sql = getSql();
  const rows = await sql`SELECT id FROM vendor_bills WHERE status IN ('approved', 'posted') ORDER BY received_at DESC`;

  const seals = [];
  for (const row of rows) {
    const inv = await getFrontendInvoice(row.id);
    if (inv) seals.push({ id: inv.id, vendor: inv.vendor, amount: inv.amount, confidence: inv.confidenceScore });
  }
  return Response.json(seals);
}
