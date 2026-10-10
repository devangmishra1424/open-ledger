import { createPurchaseOrder, listPurchaseOrders, receiptFromBody } from "@/lib/purchase-orders";
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
 *   { vendor | vendorId, poNumber, orderDate?, currency?, buyerName?,
 *     items: [{ description, qty, rate, uom? }],
 *     receipt?: { receivedInFull?: true, lines?: [{ line, qty }], receiptDate?, receiverName?, condition? } }
 * With `receipt`, the goods receipt is recorded in the same transaction. 400 malformed, 409 if a PO
 * with this number already exists. An unknown vendor name creates the vendor with trust tier 'new'.
 */
export const POST = handle("POST /api/purchase-orders", async (req) => {
  const body = await readJsonBody(req);
  if (!Array.isArray(body.items)) throw new HttpError(400, "items must be an array of { description, qty, rate }");

  const created = await createPurchaseOrder({
    vendorId: typeof body.vendorId === "string" ? body.vendorId : undefined,
    vendorName: typeof body.vendor === "string" ? body.vendor : undefined,
    poNumber: body.poNumber as string,
    orderDate: typeof body.orderDate === "string" ? body.orderDate : null,
    currency: typeof body.currency === "string" ? body.currency : null,
    buyerName: typeof body.buyerName === "string" ? body.buyerName : null,
    lines: body.items.map((it: any) => ({ description: it?.description, quantity: it?.qty, unitPrice: it?.rate, uom: typeof it?.uom === "string" ? it.uom : null })),
    receipt: body.receipt === undefined || body.receipt === null ? null : receiptFromBody(body.receipt),
  });
  return Response.json(created, { status: 201 });
});
