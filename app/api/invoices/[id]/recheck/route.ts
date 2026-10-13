import { startRecheck } from "@/lib/pipeline/recheck";
import { handle, optionalString, readJsonBody, reviewerName } from "@/lib/http";

/**
 * POST /api/invoices/:id/recheck: check an invoice again against its purchase order and what has been received, for
 * when either changed after it was saved. { reviewerName, poNumber? }: poNumber links a non-PO invoice to that PO
 * (it must be on file for the same vendor). 202: the re-check has started (the invoice is 'processing' until it
 * finishes). 409 the invoice is not waiting for a person (decided, or being checked); 422 the typed PO is not on file
 * for the invoice's vendor. See lib/pipeline/recheck.ts.
 */
export const POST = handle("POST /api/invoices/:id/recheck", async (req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJsonBody(req);
  const by = reviewerName(body, req);
  const poNumber = optionalString(body, "poNumber", { max: 60 }) ?? null;
  const started = await startRecheck(id, { kind: "manual", by }, { poNumber });
  return Response.json(started, { status: 202 });
});
