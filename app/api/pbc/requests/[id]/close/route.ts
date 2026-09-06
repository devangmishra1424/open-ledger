import { closePbcRequest } from "@/lib/pbc-shapes";

/** POST /api/pbc/requests/:id/close */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const closed = await closePbcRequest(id);
  if (!closed) return Response.json({ error: `no pbc_requests row found with id '${id}'` }, { status: 404 });
  return Response.json({ success: true, requestId: id, status: "closed" });
}
