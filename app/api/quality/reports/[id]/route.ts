import { getReport } from "@/lib/evals/store";
import { handle, HttpError } from "@/lib/http";

/** GET /api/quality/reports/:id — one saved report in full; ?format=json downloads it as a file. 404 if unknown. */
export const GET = handle("GET /api/quality/reports/:id", async (req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, "not a report id");
  const saved = await getReport(id);
  if (!saved) throw new HttpError(404, `no saved report ${id}`);
  if (new URL(req.url).searchParams.get("format") !== "json") return Response.json(saved);
  const day = saved.summary.createdAt.slice(0, 10);
  return new Response(JSON.stringify(saved.report, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="veribook-${saved.summary.kind}-report-${day}.json"` },
  });
});
