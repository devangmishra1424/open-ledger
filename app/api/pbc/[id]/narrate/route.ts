import { narratePbcResponse } from "@/lib/audit/narrator";

/**
 * POST /api/pbc/:id/narrate
 * Queries the PBC narrator to explain why the decisions linked to this PBC request were made.
 * Expected body: { question: string }
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  if (!body.question) {
    return Response.json({ error: "question is required" }, { status: 400 });
  }

  try {
    const results = await narratePbcResponse(id, body.question);
    return Response.json({ results });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
