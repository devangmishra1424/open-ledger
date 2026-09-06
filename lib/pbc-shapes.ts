import { getSql } from "@/db/client";

/**
 * Translation layer for the PBC (Provided-By-Client audit support) feature — same rationale as
 * lib/api-shapes.ts. The real `pbc_requests` table (db/schema.sql) predates any UI and has its
 * own real shape (item_type, owner_name, status enum 'open'|'assembled'|'submitted'|'accepted'|
 * 'exception', linked_invoice_ids as a comma-separated TEXT column — this module's own
 * convention, since nothing wrote to this column before now). The frontend's AuditTrail page
 * (checked directly against frontend/src/pages/AuditTrail.jsx + data/mockData.js) expects a
 * different shape (`request_id`, `requested_by`, `tie_out_status`) and a second concept —
 * "EvidenceRecord" — that has NO backing table at all (INTEGRATION.md §2 already flagged
 * `lib/audit/*` as real, scoped, not-yet-built work). Evidence records are therefore derived
 * here, on read, from each linked invoice's real decisions — never persisted, never fabricated.
 */

export interface FrontendPbcRequest {
  request_id: string;
  description: string;
  requested_by: string;
  date_requested: string;
  status: "open" | "in_progress" | "closed";
  tie_out_status: "matched" | "discrepant";
}

export interface FrontendEvidenceRecord {
  evidence_id: string;
  request_id: string;
  invoice_id: string;
  vendor: string;
  amount: number;
  tie_out_status: "matched" | "discrepant";
  discrepancy_reason: string;
  control_objective_tags: string[];
  agent_attestations: string[];
  attestation_hash: string;
}

function statusToFrontend(status: string): FrontendPbcRequest["status"] {
  if (status === "accepted") return "closed";
  if (status === "open") return "open";
  return "in_progress"; // assembled, submitted, exception
}

/** REASON_CODE -> control-objective tag, per the frontend's own fixed tag vocabulary. Falls back to FIN-302 (general financial accuracy) when a code doesn't map to a more specific one. */
function tagsForReasonCode(reasonCode: string | null): string[] {
  if (!reasonCode) return ["FIN-302"];
  if (reasonCode === "EXC-FRAUD_BANK") return ["FRAUD-901", "AUTH-202"];
  if (reasonCode === "EXC-TAX_VAR") return ["TAX-401"];
  if (reasonCode.startsWith("EXC-") && (reasonCode.includes("PO") || reasonCode.includes("QTY") || reasonCode.includes("PRICE"))) return ["COMP-204"];
  if (reasonCode === "EXC-DUPLICATE") return ["DUPL-101"];
  return ["FIN-302"];
}

export async function listFrontendPbcRequests(): Promise<FrontendPbcRequest[]> {
  const sql = getSql();
  const rows = await sql`SELECT * FROM pbc_requests ORDER BY created_at DESC`;

  const results: FrontendPbcRequest[] = [];
  for (const row of rows) {
    const linkedIds: string[] = (row.linked_invoice_ids ?? "").split(",").filter(Boolean);
    let tieOutStatus: FrontendPbcRequest["tie_out_status"] = "matched";
    if (linkedIds.length > 0) {
      const billRows = await sql`SELECT status FROM vendor_bills WHERE id = ANY(${linkedIds})`;
      if (billRows.some((b: any) => b.status === "exception" || b.status === "void")) tieOutStatus = "discrepant";
    }
    results.push({
      request_id: row.id,
      description: row.description,
      requested_by: row.owner_name ?? "Unassigned",
      date_requested: (row.created_at as string).slice(0, 10),
      status: statusToFrontend(row.status),
      tie_out_status: tieOutStatus,
    });
  }
  return results;
}

export async function closePbcRequest(requestId: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`UPDATE pbc_requests SET status = 'accepted' WHERE id = ${requestId} RETURNING id`;
  return rows.length > 0;
}

/** One derived EvidenceRecord per linked invoice, across every PBC request (or just one, if requestId is given). */
export async function listFrontendEvidenceRecords(requestId?: string): Promise<FrontendEvidenceRecord[]> {
  const sql = getSql();
  const requests = requestId
    ? await sql`SELECT * FROM pbc_requests WHERE id = ${requestId}`
    : await sql`SELECT * FROM pbc_requests`;

  const results: FrontendEvidenceRecord[] = [];
  for (const req of requests) {
    const linkedIds: string[] = (req.linked_invoice_ids ?? "").split(",").filter(Boolean);
    for (const billId of linkedIds) {
      const billRows = await sql`SELECT vb.*, v.name as vendor_name FROM vendor_bills vb JOIN vendors v ON v.id = vb.vendor_id WHERE vb.id = ${billId}`;
      const bill = billRows[0];
      if (!bill) continue;

      const decisionRows = await sql`SELECT node_id, action_taken, reason_code, hash FROM decisions WHERE invoice_id = ${billId} AND superseded_by_id IS NULL ORDER BY seq ASC`;
      const isDiscrepant = bill.status === "exception" || bill.status === "void";
      const dominantFinding = decisionRows.find((d: any) => d.node_id === "match" && d.reason_code && d.reason_code !== "CLEAN_MATCH");
      const agentAttestations = decisionRows
        .filter((d: any) => d.action_taken != null)
        .map((d: any) => d.node_id.charAt(0).toUpperCase() + d.node_id.slice(1) + " Agent");
      const latestHash = decisionRows.length > 0 ? decisionRows[decisionRows.length - 1].hash : "";

      results.push({
        evidence_id: `EV-${billId.slice(0, 8)}`,
        request_id: req.id,
        invoice_id: billId,
        vendor: bill.vendor_name,
        amount: bill.total_amount,
        tie_out_status: isDiscrepant ? "discrepant" : "matched",
        discrepancy_reason: isDiscrepant && dominantFinding ? `${dominantFinding.reason_code}: ${dominantFinding.action_taken}` : "",
        control_objective_tags: tagsForReasonCode(dominantFinding?.reason_code ?? null),
        agent_attestations: agentAttestations,
        attestation_hash: latestHash,
      });
    }
  }
  return results;
}
