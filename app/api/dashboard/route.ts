import { getSql } from "@/db/client";
import { getAllDecisionsInOrder, toChainableRecord } from "@/lib/ledger/decisions";
import { verifyChain } from "@/lib/ledger/hash-chain";

/**
 * GET /api/dashboard — the frontend's `mockLedgerSummary` shape (frontend/src/data/mockData.js,
 * checked directly), backed entirely by real aggregate queries — no field here is fabricated.
 * INTEGRATION.md §"GET /api/dashboard" already named the two hardest ones (stpRate,
 * chainVerified) as "your route writes directly"; this is that route.
 */
export async function GET() {
  const sql = getSql();

  const [statusCounts, activeValue, allTimeVolume, correctionsRows, policyCounts, postedTodayRows, decisionHealth, weeklyRows] = await Promise.all([
    sql`SELECT status, COUNT(*)::int as n FROM vendor_bills GROUP BY status`,
    sql`SELECT COALESCE(SUM(total_amount), 0) as total FROM vendor_bills WHERE status IN ('processing', 'matched', 'exception')`,
    sql`SELECT COALESCE(SUM(total_amount), 0) as total, COUNT(*)::int as n FROM vendor_bills`,
    sql`SELECT COUNT(*)::int as n FROM vendor_corrections`,
    sql`SELECT COUNT(*) FILTER (WHERE action_taken = 'auto_approve')::int as approved, COUNT(*)::int as total FROM decisions WHERE node_id = 'policy'`,
    sql`SELECT COUNT(*)::int as n FROM journal_entries WHERE source_type = 'vendor_bill' AND posted_at::date = CURRENT_DATE`,
    sql`SELECT COUNT(*) FILTER (WHERE action_taken = 'error')::int as errors, COUNT(*)::int as total FROM decisions`,
    // One round trip for the whole 7-day window (day_offset 6..0), instead of 7 sequential
    // queries — the sequential version measured at 15-60s total against real Supabase network
    // latency, which is what made this whole route feel hung from the frontend's side.
    sql`
      SELECT d.day_offset, COUNT(vb.id)::int as n
      FROM generate_series(0, 6) as d(day_offset)
      LEFT JOIN vendor_bills vb ON vb.received_at::date = (CURRENT_DATE - d.day_offset)
      GROUP BY d.day_offset
      ORDER BY d.day_offset DESC
    `,
  ]);

  const byStatus = (s: string) => statusCounts.find((r: any) => r.status === s)?.n ?? 0;
  const cleanCount = byStatus("approved") + byStatus("posted") + byStatus("paid");
  const reviewCount = byStatus("exception");
  const blockedCount = byStatus("void");

  const policyTotal = policyCounts[0].total;
  const stpRate = policyTotal > 0 ? Math.round((policyCounts[0].approved / policyTotal) * 1000) / 10 : 0;

  const decisionTotal = decisionHealth[0].total;
  const pipelineHealth = decisionTotal > 0 ? Math.round((1 - decisionHealth[0].errors / decisionTotal) * 100) : 100;

  const allDecisions = await getAllDecisionsInOrder();
  const chainVerified = verifyChain(allDecisions.map(toChainableRecord)).valid;

  // weeklyRows is ordered day_offset DESC (6..0), i.e. oldest-day-first chronologically —
  // day_offset=6 is 6 days ago, day_offset=0 is today — matching the frontend's own bar order
  // (RightPanel.jsx: idx===6 is "today"), no re-ordering needed.
  const weeklyVolume = weeklyRows.map((r: any) => r.n);

  return Response.json({
    totalValue: Number(activeValue[0].total),
    totalProcessedCount: allTimeVolume[0].n,
    cleanCount,
    reviewCount,
    blockedCount,
    lastSync: new Date().toISOString(),
    totalVolumeUSD: Number(allTimeVolume[0].total),
    stpRate,
    correctionsLearned: correctionsRows[0].n,
    chainVerified,
    sealedToday: postedTodayRows[0].n,
    pipelineHealth,
    weeklyVolume,
  });
}
