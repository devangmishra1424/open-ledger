import { runPipeline } from "@/lib/pipeline/orchestrator";
import { listFrontendInvoices, getFrontendInvoice, MAX_LIST_LIMIT } from "@/lib/api-shapes";
import { createBill } from "@/lib/bills";
import { runInBackground } from "@/lib/background";
import { handle, HttpError, readJsonBody } from "@/lib/http";

export const maxDuration = 60; // the pipeline (LLM stages) runs after the response; keep the invocation alive

/**
 * GET /api/invoices?limit=100 — newest first, at most MAX_LIST_LIMIT. Each invoice carries its
 * state, one-line summary, and which actions are currently allowed (lib/api-shapes.ts).
 */
export const GET = handle("GET /api/invoices", async (req) => {
  const raw = new URL(req.url).searchParams.get("limit");
  let limit: number | undefined;
  if (raw !== null) {
    limit = Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) throw new HttpError(400, `limit must be an integer from 1 to ${MAX_LIST_LIMIT}`);
  }
  return Response.json(await listFrontendInvoices({ limit }));
});

/**
 * POST /api/invoices — a structured invoice: { vendor | vendorId, invoiceNumber?, invoiceDate?,
 * dueDate?, currency?, poNumber | poId?, items: [{ description, qty, rate }], tax?, totalAmount? }.
 * Validated at the edge (400 malformed, 422 if the stated total isn't lines + tax, 409 if this
 * vendor already sent this invoice number), created in one transaction, then the pipeline runs
 * in the background — poll GET /api/invoices/:id for the result.
 */
export const POST = handle("POST /api/invoices", async (req) => {
  const body = await readJsonBody(req);
  const items = body.items;
  if (!Array.isArray(items)) throw new HttpError(400, "items must be an array of { description, qty, rate }");

  const created = await createBill({
    vendorId: typeof body.vendorId === "string" ? body.vendorId : undefined,
    vendorName: typeof body.vendor === "string" ? body.vendor : undefined,
    poId: typeof body.poId === "string" ? body.poId : null,
    poNumber: typeof body.poNumber === "string" ? body.poNumber : null,
    invoiceNumber: typeof body.invoiceNumber === "string" ? body.invoiceNumber : null,
    invoiceDate: typeof body.invoiceDate === "string" ? body.invoiceDate : null,
    dueDate: typeof body.dueDate === "string" ? body.dueDate : null,
    currency: typeof body.currency === "string" ? body.currency : null,
    lines: items.map((it: any) => ({ description: it?.description, quantity: it?.qty, unitPrice: it?.rate })),
    tax: typeof body.tax === "number" ? body.tax : null,
    total: typeof body.totalAmount === "number" ? body.totalAmount : null,
    rawSource: typeof body.rawSource === "string" ? body.rawSource : null,
    strictTotals: true,
  });

  runInBackground(`runPipeline(${created.billId})`, () => runPipeline(created.billId));

  const invoice = await getFrontendInvoice(created.billId);
  return Response.json(invoice, { status: 201 });
});
