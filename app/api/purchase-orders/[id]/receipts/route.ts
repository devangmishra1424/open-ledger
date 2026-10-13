import { recordReceipt, receiptFromBody } from "@/lib/purchase-orders";
import { recheckWaitingForReceipt } from "@/lib/pipeline/recheck";
import { handle, readJsonBody } from "@/lib/http";

/**
 * POST /api/purchase-orders/:id/receipts — goods received against a PO:
 *   { receivedInFull?: true, lines?: [{ line, qty }], receiptDate?, receiverName?, condition? }
 * 404 unknown PO, 409 if the PO is closed or this exact receipt is already recorded, 400 malformed.
 * Only accepted receipts count toward "received" in the match; a damaged or rejected one is recorded
 * but does not clear an invoice.
 *
 * An accepted receipt re-checks the PO's invoices that were stopped for a receiving reason (goods not received yet,
 * received after the invoice, fewer received than billed): `recheckedInvoices` lists them (lib/pipeline/recheck.ts).
 */
export const POST = handle("POST /api/purchase-orders/:id/receipts", async (req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJsonBody(req);
  const receipt = await recordReceipt(id, receiptFromBody(body));
  const recheckedInvoices = receipt.condition === "accepted" ? await recheckWaitingForReceipt({ id, poNumber: receipt.poNumber }, receipt.receiptDate) : [];
  return Response.json({ receiptId: receipt.receiptId, recheckedInvoices }, { status: 201 });
});
