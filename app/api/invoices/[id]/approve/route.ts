import { approveInvoice } from "@/lib/ledger/human-review";
import { getFrontendInvoice } from "@/lib/api-shapes";
import { getSql } from "@/db/client";
import { parseAccounts } from "@/lib/auth/accounts";
import { approvalRefusal } from "@/lib/auth/authority";
import { handle, HttpError, optionalString, readJsonBody, reviewerName, sessionUser } from "@/lib/http";

/**
 * POST /api/invoices/:id/approve — a human approves an invoice that is waiting on a person.
 * Body: { reviewerName, reason? }. Posts it to the ledger, records who approved it in the hash
 * chain, and pays what is owed on it — nothing for a credit memo (`noPayment`). 409 if its state doesn't allow approval (already rejected, bank-detail
 * change not yet verified, still processing); approving an already-approved invoice is a no-op.
 * Signed in (VERIBOOK_USERS): 403 when the person is a clerk, the invoice is over their approval limit for its currency,
 * or they entered it themselves (lib/auth/authority.ts). Open mode (no sign-in) has no accounts to check.
 */
export const POST = handle("POST /api/invoices/:id/approve", async (req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJsonBody(req);
  const user = sessionUser(req);
  if (user) {
    const account = parseAccounts(process.env.VERIBOOK_USERS).find((a) => a.username.toLowerCase() === user.username.toLowerCase());
    if (!account) throw new HttpError(403, "your account is no longer on the list of users");
    const [bill] = await getSql()`
      SELECT vb.total_amount, vb.currency,
        (SELECT COALESCE(d.triggered_by_actor, substring(d.agent_id from 7)) FROM decisions d
          WHERE d.invoice_id = vb.id AND d.node_id = 'extract' AND d.agent_id LIKE 'human:%' ORDER BY d.seq LIMIT 1) AS entered_by
      FROM vendor_bills vb WHERE vb.id = ${id}`;
    if (!bill) throw new HttpError(404, `no invoice '${id}'`);
    const refusal = approvalRefusal(account, { amount: Number(bill.total_amount), currency: bill.currency, enteredBy: bill.entered_by ?? null });
    if (refusal) throw new HttpError(403, refusal);
  }
  const outcome = await approveInvoice({ billId: id, reviewer: reviewerName(body, req), note: optionalString(body, "reason") });
  const invoice = await getFrontendInvoice(id);
  return Response.json({
    success: true,
    alreadyDone: outcome.alreadyDone,
    payment: outcome.payment ? { reference: outcome.payment.reference, simulated: outcome.payment.simulated } : undefined,
    paymentError: outcome.paymentError,
    noPayment: outcome.noPayment,
    invoice,
  });
});
