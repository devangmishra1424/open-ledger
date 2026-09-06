import { explain } from "@/lib/explain";
import { getDecisionsForInvoice } from "@/lib/ledger/decisions";

/** POST /api/invoices/:id/explain — real, grounded Q&A over this invoice's actual decision records. Body: { question: string, decisionId?: string }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const question: string = body.question ?? "Why did this invoice land where it did?";
  let decisionId: string = body.decisionId ?? "";

  if (!decisionId) {
    // No specific node clicked — anchor to the invoice's own latest decision (the one that
    // determined where it currently sits), rather than requiring the caller to know a real id.
    const decisions = await getDecisionsForInvoice(id);
    if (decisions.length === 0) return Response.json({ error: `no invoice found with id '${id}'` }, { status: 404 });
    decisionId = decisions[decisions.length - 1].id;
  }

  try {
    const result = await explain(id, decisionId, question);
    return Response.json({ success: true, ...result });
  } catch (e) {
    return Response.json({ success: false, answer: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
