import { contestInvoice } from "@/lib/ledger/human-review";
import { getFrontendInvoice } from "@/lib/api-shapes";
import { handle, readJsonBody, requireString, reviewerName } from "@/lib/http";

/**
 * POST /api/invoices/:id/contest — a person challenges the system's decision. Body:
 * { reviewerName, reason } where `reason` is the question put to the AI re-review ("the vendor
 * confirmed the new bank account by phone on 3 Oct — does that change anything?").
 * The challenge is recorded in the hash chain first, then the Investigator/Verifier are asked
 * to reconsider with that reason (lib/pipeline/reconsider.ts). If the invoice was stopped by a
 * deterministic rule before any AI ran there is nothing to reconsider, and the response says so.
 */
export const POST = handle("POST /api/invoices/:id/contest", async (req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJsonBody(req);
  const outcome = await contestInvoice({ billId: id, reviewer: reviewerName(body), reason: requireString(body, "reason", { max: 1000 }) });
  const invoice = await getFrontendInvoice(id);
  return Response.json({ success: true, reconsideration: outcome.reconsideration, invoice });
});
