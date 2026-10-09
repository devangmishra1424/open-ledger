import { extractPdfText, isPdfDataUrl } from "@/lib/pdf-text";
import { parsePurchaseOrderText } from "@/lib/order-docs";
import { handle, HttpError, readJsonBody, requireString } from "@/lib/http";

const MAX_TEXT_CHARS = 200_000;

/**
 * POST /api/purchase-orders/parse — { rawText } (plain text, or a data:application/pdf;base64,... URL).
 * Reads a purchase-order document into a DRAFT { vendorName, poNumber, orderDate, currency, lines,
 * missing } and writes nothing: the person checks and edits it, then saves with POST /api/purchase-orders.
 * No AI is used; what cannot be read is listed in `missing`.
 */
export const POST = handle("POST /api/purchase-orders/parse", async (req) => {
  const body = await readJsonBody(req);
  let text = requireString(body, "rawText", { max: 12_000_000 });
  if (isPdfDataUrl(text)) text = await extractPdfText(text);
  if (text.length > MAX_TEXT_CHARS) throw new HttpError(413, `document text is too long (max ${MAX_TEXT_CHARS} characters)`);
  return Response.json(parsePurchaseOrderText(text));
});
