import { makeVoiceCallback } from "@/lib/voice";
import { getBankChangeReview } from "@/lib/ledger/bank-change-review";

/** 
 * POST /api/reviews/:id/callback
 * Triggers the Smallest.ai outbound voice callback for a vendor bank change review.
 * Expected body: { phoneNumber?: string, vendorName?: string, reviewerName?: string }
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const review = await getBankChangeReview(id);
  if (!review) return Response.json({ error: `no vendor_bank_change_review found with id '${id}'` }, { status: 404 });

  // In a real app, we'd fetch the vendor's actual phone number from the vendors table
  // and the reviewer's name from their active session.
  const phoneNumber = body.phoneNumber ?? "+15550199999";
  const vendorName = body.vendorName ?? "Vendor";
  const reviewerName = body.reviewerName ?? "Demo Reviewer";

  try {
    const result = await makeVoiceCallback(id, phoneNumber, vendorName, reviewerName);
    return Response.json({ success: true, ...result });
  } catch (e) {
    return Response.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
