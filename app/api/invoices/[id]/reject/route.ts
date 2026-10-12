import { rejectInvoice } from "@/lib/ledger/human-review";
import { getFrontendInvoice } from "@/lib/api-shapes";
import { handle, optionalString, readJsonBody, reviewerName } from "@/lib/http";

/**
 * POST /api/invoices/:id/reject — a human rejects an invoice that is waiting on a person.
 * Body: { reviewerName, reason? }. Marks it void and records who rejected it in the hash chain.
 * 409 if it was already approved/posted/paid (reverse the ledger entry instead); rejecting an
 * already-rejected invoice is a no-op.
 */
export const POST = handle("POST /api/invoices/:id/reject", async (req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJsonBody(req);
  const outcome = await rejectInvoice({ billId: id, reviewer: reviewerName(body, req), note: optionalString(body, "reason") });
  const invoice = await getFrontendInvoice(id);
  return Response.json({ success: true, alreadyDone: outcome.alreadyDone, invoice });
});
