import { explain, type ExplainResult } from "@/lib/explain";
import { getSql } from "@/db/client";

/**
 * Wraps the explain mechanic scoped to a PBC (Provided-By-Client) request.
 * Finds all invoices linked to the PBC request, and runs the "ask why" explanation
 * over each one to answer the auditor's question.
 */
export async function narratePbcResponse(requestId: string, question: string): Promise<ExplainResult[]> {
  const sql = getSql();
  const requests = await sql`SELECT * FROM pbc_requests WHERE id = ${requestId}`;
  if (requests.length === 0) throw new Error(`narratePbcResponse: no pbc_requests row found with id '${requestId}'`);

  const req = requests[0];
  const linkedIds: string[] = (req.linked_invoice_ids ?? "").split(",").filter(Boolean);

  const results: ExplainResult[] = [];
  
  for (const invoiceId of linkedIds) {
    // Anchor to the latest decision for the invoice
    const decisionsRows = await sql`SELECT id FROM decisions WHERE invoice_id = ${invoiceId} ORDER BY seq DESC LIMIT 1`;
    if (decisionsRows.length > 0) {
      const anchorDecisionId = decisionsRows[0].id;
      const res = await explain(invoiceId, anchorDecisionId, question);
      results.push(res);
    }
  }

  return results;
}
