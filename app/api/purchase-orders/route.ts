import { createPurchaseOrder, listPurchaseOrders, receiptFromBody } from "@/lib/purchase-orders";
import { getDocument, PURPOSE_WORDS } from "@/lib/documents/store";
import { recheckWaitingForNewPo } from "@/lib/pipeline/recheck";
import { handle, HttpError, readJsonBody } from "@/lib/http";

/**
 * GET /api/purchase-orders?limit=50 — newest first (max 200), each with its lines, what has been
 * received (accepted receipts only) and how many invoices are billed against it.
 */
export const GET = handle("GET /api/purchase-orders", async (req) => {
  const raw = new URL(req.url).searchParams.get("limit");
  let limit: number | undefined;
  if (raw !== null) {
    limit = Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, "limit must be an integer from 1 to 200");
  }
  return Response.json(await listPurchaseOrders(limit));
});

/**
 * POST /api/purchase-orders — the PO an invoice is matched against:
 *   { vendor | vendorId, poNumber, orderDate?, currency?, buyerName?, spendingLimit? (a blanket order's total limit),
 *     items: [{ description, qty, rate, uom? }],
 *     receipt?: { receivedInFull?: true, lines?: [{ line, qty }], receiptDate?, receiverName?, condition? },
 *     sourceDocumentId? }  (the PO document it was read from: POST /api/documents/read with purpose purchase_order)
 * With `receipt`, the goods receipt is recorded in the same transaction. 400 malformed, 409 if a PO
 * with this number already exists. An unknown vendor name creates the vendor with trust tier 'new'.
 *
 * Invoices that were saved before this PO existed, cite its number and come from the same vendor are linked to it
 * and checked again: `recheckedInvoices` lists them (lib/pipeline/recheck.ts).
 */
export const POST = handle("POST /api/purchase-orders", async (req) => {
  const body = await readJsonBody(req);
  if (!Array.isArray(body.items)) throw new HttpError(400, "items must be an array of { description, qty, rate }");
  let sourceDocumentId: string | null = null;
  if (body.sourceDocumentId != null) {
    const doc = typeof body.sourceDocumentId === "string" ? await getDocument(body.sourceDocumentId) : null;
    if (!doc) throw new HttpError(404, `no document '${String(body.sourceDocumentId)}'`);
    if (doc.purpose !== "purchase_order") throw new HttpError(400, `that document was read as ${PURPOSE_WORDS[doc.purpose]}, not a purchase order`);
    if (doc.purchaseOrderId) throw new HttpError(409, `that document was already saved as a purchase order (id ${doc.purchaseOrderId})`);
    sourceDocumentId = doc.id;
  }

  const created = await createPurchaseOrder({
    vendorId: typeof body.vendorId === "string" ? body.vendorId : undefined,
    vendorName: typeof body.vendor === "string" ? body.vendor : undefined,
    poNumber: body.poNumber as string,
    orderDate: typeof body.orderDate === "string" ? body.orderDate : null,
    currency: typeof body.currency === "string" ? body.currency : null,
    buyerName: typeof body.buyerName === "string" ? body.buyerName : null,
    spendingLimit: spendingLimitOf(body.spendingLimit),
    lines: body.items.map((it: any) => ({ description: it?.description, quantity: it?.qty, unitPrice: it?.rate, uom: typeof it?.uom === "string" ? it.uom : null })),
    receipt: body.receipt === undefined || body.receipt === null ? null : receiptFromBody(body.receipt),
    sourceDocumentId,
  });
  const recheckedInvoices = await recheckWaitingForNewPo({ poNumber: created.poNumber, vendorId: created.vendorId });
  return Response.json({ ...created, recheckedInvoices }, { status: 201 });
});

/** The optional spending limit: a number, a numeric string from a form field, or empty for a normal order. Range is checked by normalizePurchaseOrder. */
function spendingLimitOf(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "string" ? Number(v.replace(/,/g, "")) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new HttpError(400, "spendingLimit must be a number");
  return n;
}
