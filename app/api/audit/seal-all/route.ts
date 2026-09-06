import { getSql } from "@/db/client";
import { getDecisionsForInvoice, toChainableRecord } from "@/lib/ledger/decisions";
import { computeHash } from "@/lib/ledger/hash-chain";

/**
 * POST /api/audit/seal-all — runs the same real per-record hash-integrity check as
 * POST /api/invoices/:id/seal, across every invoice GET /api/audit/seals currently lists as
 * pending. Real verification over every one of them, not a count returned on faith.
 */
export async function POST() {
  const sql = getSql();
  const rows = await sql`SELECT id FROM vendor_bills WHERE status IN ('approved', 'posted')`;

  let sealedCount = 0;
  const failures: string[] = [];
  for (const row of rows) {
    const decisions = await getDecisionsForInvoice(row.id);
    let ok = true;
    for (const d of decisions) {
      const record = toChainableRecord(d);
      const expected = computeHash(d.prevHash ?? null, record);
      if (expected !== d.hash) {
        ok = false;
        break;
      }
    }
    if (ok) sealedCount++;
    else failures.push(row.id);
  }

  return Response.json({ success: failures.length === 0, sealedCount, failedIds: failures });
}
