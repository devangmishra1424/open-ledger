import { getSql } from "@/db/client";
import { getDecisionsForInvoice } from "@/lib/ledger/decisions";
import { reconsider, isEscalateSeniorResult } from "@/lib/pipeline/reconsider";
import { getFrontendInvoice } from "@/lib/api-shapes";

/**
 * POST /api/invoices/:id/contest — a human review action that also triggers a real
 * reconsideration (ENGINE.md §6b), not just a logged note. Finds the latest
 * non-superseded investigate/verify decision for this invoice — the only node types
 * reconsider() accepts (lib/pipeline/reconsider.ts) — and re-invokes it with the human's
 * reason as the question. If this invoice has no such decision (e.g. it cascaded through a
 * deterministic validate/match block with nothing to reconsider), the review is still
 * logged, just without a reconsideration — reconsider() would throw for those node types,
 * so this route doesn't call it rather than surface a confusing 500.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sql = getSql();
  const body = await req.json().catch(() => ({}));
  const reviewerName: string = body.reviewerName ?? "demo-reviewer";
  const reason: string = body.reason ?? "Contested via UI";

  const decisions = await getDecisionsForInvoice(id);
  if (decisions.length === 0) return Response.json({ error: `no invoice found with id '${id}'` }, { status: 404 });

  await sql`INSERT INTO reviews (id, invoice_id, reviewer_name, action, note) VALUES (${crypto.randomUUID()}, ${id}, ${reviewerName}, 'contest', ${reason})`;

  const reconsiderable = decisions.filter((d) => !d.supersededById && (d.nodeId === "investigate" || d.nodeId === "verify"));
  const target = reconsiderable[reconsiderable.length - 1]; // latest one

  let reconsiderResult: unknown = null;
  if (target) {
    const result = await reconsider({ originalDecisionId: target.id, question: reason, actor: reviewerName });
    reconsiderResult = isEscalateSeniorResult(result)
      ? { escalatedToSenior: true, message: result.error }
      : { cascaded: result.cascaded, newDecisionId: result.newDecision.id };
  }

  const invoice = await getFrontendInvoice(id);
  return Response.json({ success: true, invoice, reconsider: reconsiderResult });
}
