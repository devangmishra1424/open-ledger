import { recordSecondReviewerSignOff } from "@/lib/ledger/bank-change-review";
import { bankChangeCall } from "@/lib/ledger/bank-change-http";
import { handle, readJsonBody, reviewerName } from "@/lib/http";

/**
 * POST /api/reviews/:id/sign-off — step 3 (maker/checker): a DIFFERENT reviewer than the one
 * who made the callback signs off the confirmed bank change. That releases the hold on the
 * vendor's invoices. 409 if it is the same person, or the review isn't in "callback_confirmed".
 * Body: { reviewerName }.
 */
export const POST = handle("POST /api/reviews/:id/sign-off", async (req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJsonBody(req);
  const reviewer = reviewerName(body);
  const updated = await bankChangeCall(() => recordSecondReviewerSignOff(id, reviewer));
  return Response.json({ success: true, review: updated });
});
