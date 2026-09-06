import { getSql } from "@/db/client";
import { postBillApproval } from "@/lib/ledger/journal";
import { getFrontendInvoice } from "@/lib/api-shapes";

/** POST /api/invoices/:id/approve — a human review action (schema's `reviews.action='approve'`). Posts the real journal entry if not already posted. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sql = getSql();
  const body = await req.json().catch(() => ({}));
  const reviewerName: string = body.reviewerName ?? "demo-reviewer";

  const billRows = await sql`SELECT status FROM vendor_bills WHERE id = ${id}`;
  if (billRows.length === 0) return Response.json({ error: `no invoice found with id '${id}'` }, { status: 404 });

  await sql`INSERT INTO reviews (id, invoice_id, reviewer_name, action, note) VALUES (${crypto.randomUUID()}, ${id}, ${reviewerName}, 'approve', ${body.reason ?? null})`;

  if (!["posted", "paid"].includes(billRows[0].status)) {
    try {
      await postBillApproval(id);
    } catch (e) {
      return Response.json({ error: `could not post: ${e instanceof Error ? e.message : String(e)}` }, { status: 422 });
    }
  }

  const invoice = await getFrontendInvoice(id);
  return Response.json({ success: true, invoice });
}
