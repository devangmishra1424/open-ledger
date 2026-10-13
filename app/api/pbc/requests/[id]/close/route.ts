import { closePbcRequest } from "@/lib/audit/pbc";
import { handle, readJsonBody, reviewerName } from "@/lib/http";

/**
 * POST /api/pbc/requests/:id/close — hand the evidence over and close the request. Body: { reviewerName }
 * (ignored when signed in: the account closes it). Writes an `audit_assemble` record on every linked
 * invoice's trail and records who closed it (lib/audit/pbc.ts). Closing a closed request is a no-op.
 */
export const POST = handle("POST /api/pbc/requests/:id/close", async (req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJsonBody(req);
  const result = await closePbcRequest(id, reviewerName(body, req));
  if (!result) return Response.json({ error: `no pbc_requests row found with id '${id}'` }, { status: 404 });
  return Response.json({ success: true, requestId: id, status: "closed", ...result });
});
