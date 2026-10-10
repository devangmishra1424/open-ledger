import { getBankChangeReview, recordCallbackOutcome } from "@/lib/ledger/bank-change-review";
import { bankChangeCall } from "@/lib/ledger/bank-change-http";
import { handle, HttpError, readJsonBody, reviewerName } from "@/lib/http";

/**
 * POST /api/reviews/:id/outcome — step 2: what the vendor actually said on the call.
 * Body: { reviewerName, outcome: "confirmed" | "failed" }.
 *  - "confirmed" may only be recorded by the reviewer who logged the call (they are attesting to it).
 *  - "failed" (vendor denies it, wrong number, nobody picked up) is accepted from any reviewer —
 *    the conservative direction needs no extra permission — and flags the vendor.
 * A confirmed change still needs a DIFFERENT reviewer's sign-off before the hold clears.
 */
export const POST = handle("POST /api/reviews/:id/outcome", async (req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJsonBody(req);
  const reviewer = reviewerName(body);
  const outcome = body.outcome;
  if (outcome !== "confirmed" && outcome !== "failed") throw new HttpError(400, `outcome must be "confirmed" or "failed"`);

  const review = await getBankChangeReview(id);
  if (!review) throw new HttpError(404, `no vendor bank-change review found with id '${id}'`);
  if (outcome === "confirmed" && review.callbackConfirmedBy && review.callbackConfirmedBy.trim().toLowerCase() !== reviewer.toLowerCase()) {
    throw new HttpError(409, `only ${review.callbackConfirmedBy}, who made the call, can record that the vendor confirmed it`);
  }

  const updated = await bankChangeCall(() => recordCallbackOutcome(id, outcome));
  return Response.json({ success: true, review: updated });
});
