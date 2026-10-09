import { recordReceipt, receiptFromBody } from "@/lib/purchase-orders";
import { handle, readJsonBody } from "@/lib/http";

/**
 * POST /api/purchase-orders/:id/receipts — goods received against a PO:
 *   { receivedInFull?: true, lines?: [{ line, qty }], receiptDate?, receiverName?, condition? }
 * 404 unknown PO, 409 if the PO is closed or this exact receipt is already recorded, 400 malformed.
 * Only accepted receipts count toward "received" in the match; a damaged or rejected one is recorded
 * but does not clear an invoice.
 */
export const POST = handle("POST /api/purchase-orders/:id/receipts", async (req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJsonBody(req);
  const { receiptId } = await recordReceipt(id, receiptFromBody(body));
  return Response.json({ receiptId }, { status: 201 });
});
