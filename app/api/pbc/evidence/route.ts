import { listFrontendEvidenceRecords } from "@/lib/pbc-shapes";

/** GET /api/pbc/evidence — optional ?request_id= to scope to one PBC request. */
export async function GET(req: Request) {
  const requestId = new URL(req.url).searchParams.get("request_id") ?? undefined;
  return Response.json(await listFrontendEvidenceRecords(requestId));
}
