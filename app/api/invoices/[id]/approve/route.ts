import { approveInvoice } from "@/lib/ledger/human-review";
import { getFrontendInvoice } from "@/lib/api-shapes";
import { handle, optionalString, readJsonBody, reviewerName } from "@/lib/http";

/**
 * POST /api/invoices/:id/approve — a human approves an invoice that is waiting on a person.
 * Body: { reviewerName, reason? }. Posts it to the ledger, records who approved it in the hash
 * chain, and pays it. 409 if its state doesn't allow approval (already rejected, bank-detail
 * change not yet verified, still processing); approving an already-approved invoice is a no-op.
 */
export const POST = handle("POST /api/invoices/:id/approve", async (req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJsonBody(req);
  const outcome = await approveInvoice({ billId: id, reviewer: reviewerName(body), note: optionalString(body, "reason") });
  const invoice = await getFrontendInvoice(id);
  return Response.json({
    success: true,
    alreadyDone: outcome.alreadyDone,
    payment: outcome.payment ? { reference: outcome.payment.reference, simulated: outcome.payment.simulated } : undefined,
    paymentError: outcome.paymentError,
    invoice,
  });
});
