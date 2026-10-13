import { narratePbcResponse } from "@/lib/audit/narrator";
import { handle, readJsonBody, requireString } from "@/lib/http";
import { getSql } from "@/db/client";

/**
 * POST /api/pbc/:id/narrate — an auditor's question about one request, answered per linked invoice
 * from that invoice's recorded decisions only (lib/audit/narrator.ts). Body: { question }.
 * 200 { results, answeredFor, totalLinked } | 400 | 404.
 */
export const POST = handle("POST /api/pbc/:id/narrate", async (req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJsonBody(req);
  const question = requireString(body, "question", { max: 500 });
  const [exists] = await getSql()`SELECT id FROM pbc_requests WHERE id = ${id}`;
  if (!exists) return Response.json({ error: `no pbc_requests row found with id '${id}'` }, { status: 404 });
  return Response.json(await narratePbcResponse(id, question));
});
