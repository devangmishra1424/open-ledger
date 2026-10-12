import { getSql } from "@/db/client";
import { getBankChangeReview } from "@/lib/ledger/bank-change-review";
import { bankChangeCall } from "@/lib/ledger/bank-change-http";
import { startVendorCallback, isPlausiblePhone } from "@/lib/voice";
import { handle, HttpError, readJsonBody, requireString, reviewerName } from "@/lib/http";

/**
 * POST /api/reviews/:id/callback — step 1 of the vendor bank-change verification: the reviewer
 * says which number they are dialing and gets the script. Logs the attempt (number + who);
 * does NOT decide the outcome (see lib/voice.ts). Body: { reviewerName, phoneNumber }.
 */
export const POST = handle("POST /api/reviews/:id/callback", async (req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJsonBody(req);
  const reviewer = reviewerName(body, req);
  const phoneNumber = requireString(body, "phoneNumber", { max: 30 });
  if (!isPlausiblePhone(phoneNumber)) throw new HttpError(400, "phoneNumber must be the number you are dialing (digits, +, spaces, brackets, dashes)");

  const review = await getBankChangeReview(id);
  if (!review) throw new HttpError(404, `no vendor bank-change review found with id '${id}'`);
  const vendorRows = await getSql()`SELECT name FROM vendors WHERE id = ${review.vendorId}`;
  const vendorName: string = vendorRows[0]?.name ?? "the vendor";

  const started = await bankChangeCall(() =>
    startVendorCallback(id, phoneNumber, vendorName, reviewer, { oldLast4: review.oldBankLast4, newLast4: review.newBankLast4 }));
  return Response.json({ success: true, ...started, review: await getBankChangeReview(id) });
});
