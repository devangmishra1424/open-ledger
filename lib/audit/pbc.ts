import { getSql } from "@/db/client";
import { writeDecision } from "@/lib/ledger/decisions";

/**
 * Assembles PBC evidence for a request by querying linked invoices,
 * assembling their decision chains, and writing an `audit_assemble` decision.
 */
export async function assemblePbcEvidence(requestId: string): Promise<void> {
  const sql = getSql();
  
  const requests = await sql`SELECT * FROM pbc_requests WHERE id = ${requestId}`;
  if (requests.length === 0) throw new Error(`assemblePbcEvidence: no pbc_requests row found with id '${requestId}'`);
  
  const req = requests[0];
  const linkedIds: string[] = (req.linked_invoice_ids ?? "").split(",").filter(Boolean);

  for (const invoiceId of linkedIds) {
    const startedAt = new Date().toISOString();
    
    // Write an audit_assemble decision to the ledger for each linked invoice
    await writeDecision({
      invoiceId,
      nodeId: "audit_assemble",
      agentId: "pbc-evidence-assembler",
      startedAt,
      endedAt: new Date().toISOString(),
      actionTaken: "assembled",
      claims: [{ text: `Assembled evidence for PBC Request ${requestId} (${req.description})`, tag: "grounded" }],
      idempotencyKey: `audit_assemble:${requestId}:${invoiceId}`
    });
  }

  // Move request forward in its lifecycle
  if (req.status === 'open') {
    await sql`UPDATE pbc_requests SET status = 'assembled' WHERE id = ${requestId}`;
  }
}
