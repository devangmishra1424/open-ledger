import { getSql } from "@/db/client";
import { writeDecisionInTx } from "@/lib/ledger/decisions";

export interface ClosePbcResult {
  alreadyClosed: boolean;
  closedBy: string;
  closedAt: string;
  /** Invoices whose trail now records that they were handed to the auditor for this request. */
  evidenceRecorded: number;
}

/**
 * Closes an auditor request: the evidence is handed over. One transaction, with the request row
 * locked, so the trail entries and the status change land together or not at all, and two people
 * closing at once cannot both write them:
 *
 *  - every linked invoice gets an `audit_assemble` record on its own hash-chained trail ("provided as
 *    evidence for this request, closed by X"), so what an auditor was given is as tamper-evident as
 *    the decisions themselves;
 *  - the request records who closed it and when.
 *
 * Idempotent: closing a closed request changes nothing and reports who closed it. Each trail entry
 * also carries an idempotency key per request and invoice. Null when there is no such request.
 * `closedBy` is the acting person, already resolved by the route (lib/http.ts reviewerName).
 */
export async function closePbcRequest(requestId: string, closedBy: string): Promise<ClosePbcResult | null> {
  return getSql().begin(async (tx) => {
    const [req] = await tx`SELECT * FROM pbc_requests WHERE id = ${requestId} FOR UPDATE`;
    if (!req) return null;
    if (req.status === "accepted") {
      return { alreadyClosed: true, closedBy: req.closed_by ?? "unknown", closedAt: req.closed_at ?? "", evidenceRecorded: 0 };
    }

    const linkedIds: string[] = (req.linked_invoice_ids ?? "").split(",").filter(Boolean);
    const existing = linkedIds.length ? await tx`SELECT id FROM vendor_bills WHERE id = ANY(${linkedIds})` : [];
    const closedAt = new Date().toISOString();
    for (const { id: invoiceId } of existing) {
      await writeDecisionInTx(tx, {
        invoiceId,
        nodeId: "audit_assemble",
        agentId: `human:${closedBy}`,
        triggeredByActor: closedBy,
        startedAt: closedAt,
        endedAt: closedAt,
        actionTaken: "evidence_provided",
        claims: [{ text: `Provided as evidence for the auditor request "${req.description}" (requested by ${req.owner_name ?? "unassigned"}). Request closed by ${closedBy}.`, tag: "grounded" }],
        idempotencyKey: `audit_assemble:${requestId}:${invoiceId}`,
      });
    }

    await tx`UPDATE pbc_requests SET status = 'accepted', closed_by = ${closedBy}, closed_at = ${closedAt} WHERE id = ${requestId}`;
    return { alreadyClosed: false, closedBy, closedAt, evidenceRecorded: existing.length };
  });
}
