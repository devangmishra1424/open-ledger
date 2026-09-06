import { getSql } from "@/db/client";
import { getFrontendInvoice } from "@/lib/api-shapes";

/** POST /api/invoices/:id/reject — a human review action (schema's `reviews.action='reject'`). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sql = getSql();
  const body = await req.json().catch(() => ({}));
  const reviewerName: string = body.reviewerName ?? "demo-reviewer";

  const billRows = await sql`SELECT id FROM vendor_bills WHERE id = ${id}`;
  if (billRows.length === 0) return Response.json({ error: `no invoice found with id '${id}'` }, { status: 404 });

  await sql`INSERT INTO reviews (id, invoice_id, reviewer_name, action, note) VALUES (${crypto.randomUUID()}, ${id}, ${reviewerName}, 'reject', ${body.reason ?? null})`;
  await sql`UPDATE vendor_bills SET status = 'void' WHERE id = ${id}`;

  const invoice = await getFrontendInvoice(id);
  return Response.json({ success: true, invoice });
}
