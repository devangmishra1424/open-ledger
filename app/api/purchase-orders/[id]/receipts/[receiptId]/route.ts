import { removeReceipt } from "@/lib/purchase-orders";
import { recheckAfterReceiptRemoved } from "@/lib/pipeline/recheck";
import { handle, readJsonBody, reviewerName } from "@/lib/http";

/**
 * DELETE /api/purchase-orders/:id/receipts/:receiptId — removes a goods receipt recorded by mistake (for example the
 * PO saved as "Received in full" before its delivery note was recorded too), so those goods stop counting as received.
 * The PO's invoices still waiting on a person are checked again: `recheckedInvoices`. An invoice already approved is
 * not changed. Body: { reviewerName } when nobody is signed in (who removed it goes on the re-check's record).
 * 404 unknown PO or receipt.
 */
export const DELETE = handle("DELETE /api/purchase-orders/:id/receipts/:receiptId", async (req, { params }: { params: Promise<{ id: string; receiptId: string }> }) => {
  const { id, receiptId } = await params;
  const by = reviewerName(await readJsonBody(req), req);
  const removed = await removeReceipt(id, receiptId);
  const recheckedInvoices = await recheckAfterReceiptRemoved({ id, poNumber: removed.poNumber }, removed.receiptDate, by);
  return Response.json({ removed: receiptId, recheckedInvoices });
});
