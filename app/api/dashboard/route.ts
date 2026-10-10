import { getSql } from "@/db/client";
import { getChainStatus } from "@/lib/ledger/chain-status";
import { handle } from "@/lib/http";

/**
 * GET /api/dashboard — aggregate numbers for the overview screen, every one a real query.
 *
 *  - Money totals (totalValue, totalVolumeUSD) cover USD invoices only; nonUsdInvoiceCount says how many were left out.
 *  - needsAttention: invoices waiting on a person (exception) plus approved invoices whose
 *    payment failed. This is the number the screen exists to drive down.
 *  - stpRate: share of CURRENT policy decisions that were auto-approvals (superseded ones are
 *    history, not outcomes) — straight-through processing, no human touch. null until any exist.
 *  - pipelineHealth: share of machine decisions that did not end in an error. null until any exist
 *    (an empty system is not "100% healthy").
 *  - chainVerified: the decision hash chain recomputed from genesis (lib/ledger/chain-status.ts).
 */
export const GET = handle("GET /api/dashboard", async () => {
  const sql = getSql();

  const [statusCounts, payFailed, activeValue, allTimeVolume, correctionsRows, policyCounts, postedTodayRows, decisionHealth, weeklyRows, chain] = await Promise.all([
    sql`SELECT status, COUNT(*)::int as n FROM vendor_bills GROUP BY status`,
    sql`
      SELECT COUNT(*)::int as n FROM vendor_bills vb
      WHERE vb.status IN ('approved', 'posted') AND (
        SELECT d.action_taken FROM decisions d WHERE d.invoice_id = vb.id AND d.node_id = 'audit' AND d.superseded_by_id IS NULL ORDER BY d.seq DESC LIMIT 1
      ) = 'payment_failed'`,
    sql`SELECT COALESCE(SUM(total_amount) FILTER (WHERE currency = 'USD'), 0) as total FROM vendor_bills WHERE status IN ('processing', 'matched', 'exception')`,
    sql`SELECT COALESCE(SUM(total_amount) FILTER (WHERE currency = 'USD'), 0) as total, COUNT(*)::int as n, COUNT(*) FILTER (WHERE currency <> 'USD')::int as non_usd FROM vendor_bills`,
    sql`SELECT COUNT(*)::int as n FROM vendor_corrections`,
    sql`SELECT COUNT(*) FILTER (WHERE action_taken = 'auto_approve')::int as approved, COUNT(*)::int as total FROM decisions WHERE node_id = 'policy' AND superseded_by_id IS NULL`,
    sql`SELECT COUNT(*)::int as n FROM journal_entries WHERE source_type = 'vendor_bill' AND posted_at::date = CURRENT_DATE`,
    sql`SELECT COUNT(*) FILTER (WHERE action_taken = 'error')::int as errors, COUNT(*)::int as total FROM decisions WHERE node_id <> 'human_review'`,
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
    getChainStatus(),
  ]);

  const byStatus = (s: string) => statusCounts.find((r: any) => r.status === s)?.n ?? 0;
  const cleanCount = byStatus("approved") + byStatus("posted") + byStatus("paid") - payFailed[0].n;
  const reviewCount = byStatus("exception") + payFailed[0].n;
  const blockedCount = byStatus("void");

  const policyTotal = policyCounts[0].total;
  const stpRate = policyTotal > 0 ? Math.round((policyCounts[0].approved / policyTotal) * 1000) / 10 : null;

  const decisionTotal = decisionHealth[0].total;
  const pipelineHealth = decisionTotal > 0 ? Math.round((1 - decisionHealth[0].errors / decisionTotal) * 100) : null;

  // weeklyRows is ordered day_offset DESC (6..0), i.e. oldest-day-first chronologically —
  // day_offset=6 is 6 days ago, day_offset=0 is today — matching the frontend's own bar order
  // (RightPanel.jsx: idx===6 is "today"), no re-ordering needed.
  const weeklyVolume = weeklyRows.map((r: any) => r.n);

  return Response.json({
    totalValue: Number(activeValue[0].total),
    totalProcessedCount: allTimeVolume[0].n,
    cleanCount,
    reviewCount,
    needsAttention: reviewCount,
    blockedCount,
    lastSync: new Date().toISOString(),
    totalVolumeUSD: Number(allTimeVolume[0].total), // USD invoices only — no FX conversion exists, so other currencies are counted below, not summed in
    nonUsdInvoiceCount: allTimeVolume[0].non_usd,
    stpRate,
    correctionsLearned: correctionsRows[0].n,
    chainVerified: chain.valid,
    chainChecked: chain.checked,
    sealedToday: postedTodayRows[0].n,
    pipelineHealth,
    weeklyVolume,
  });
});
