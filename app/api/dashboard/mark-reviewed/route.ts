import { randomUUID } from "node:crypto";
import { getSql } from "@/db/client";

/**
 * POST /api/dashboard/mark-reviewed — the dashboard's bulk "Mark All Reviewed" action. There's
 * no schema concept of a per-invoice "reviewed" flag (reviews.action is one of approve/reject/
 * request_info/contest — none of which mean "looked at, no verdict yet"), so this doesn't
 * fabricate an approval nobody actually made. It logs a real `request_info` review row against
 * every currently open exception invoice — a genuine audit-trail fact ("a human did a review
 * pass over these on this date"), without changing any bill's status.
 */
export async function POST(req: Request) {
  const sql = getSql();
  const body = await req.json().catch(() => ({}));
  const reviewerName: string = body.reviewerName ?? "demo-reviewer";

  const openBills = await sql`SELECT id FROM vendor_bills WHERE status = 'exception'`;
  for (const bill of openBills) {
    await sql`
      INSERT INTO reviews (id, invoice_id, reviewer_name, action, note)
      VALUES (${randomUUID()}, ${bill.id}, ${reviewerName}, 'request_info', 'Marked reviewed via dashboard bulk action')
    `;
  }

  return Response.json({ success: true, reviewedCount: openBills.length });
}
