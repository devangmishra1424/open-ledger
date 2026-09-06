import { getSql } from "@/db/client";
import { nodeLabel } from "@/lib/api-shapes";

/** GET /api/activity — recent pipeline decisions as a flat activity feed, most recent first. */
function activityType(nodeId: string, actionTaken: string | null, reasonCode: string | null): string {
  if (nodeId === "extract") return "INVOICE_INGESTED";
  if (nodeId === "audit" && actionTaken === "auto_approve") return "SEAL_COMMITTED";
  if (reasonCode && reasonCode !== "CLEAN_MATCH") return "DISCREPANCY_FLAGGED";
  return "AGENT_DECISION";
}

export async function GET() {
  const sql = getSql();
  const rows = await sql`
    SELECT d.id, d.created_at, d.node_id, d.action_taken, d.reason_code, d.invoice_id, vb.invoice_number, vb.total_amount, v.name as vendor_name
    FROM decisions d
    JOIN vendor_bills vb ON vb.id = d.invoice_id
    JOIN vendors v ON v.id = vb.vendor_id
    ORDER BY d.seq DESC
    LIMIT 50
  `;

  const activity = rows.map((r: any) => ({
    id: r.id,
    timestamp: r.created_at,
    type: activityType(r.node_id, r.action_taken, r.reason_code),
    invoiceId: r.invoice_id,
    vendor: r.vendor_name,
    amount: r.total_amount,
    details: `${nodeLabel(r.node_id)}: ${r.action_taken ?? "no action"}${r.reason_code ? ` (${r.reason_code})` : ""}`,
  }));

  return Response.json(activity);
}
