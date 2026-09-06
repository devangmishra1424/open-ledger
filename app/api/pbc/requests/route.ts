import { randomUUID } from "node:crypto";
import { getSql } from "@/db/client";
import { listFrontendPbcRequests } from "@/lib/pbc-shapes";

/** GET /api/pbc/requests, POST /api/pbc/requests — see lib/pbc-shapes.ts for the real<->frontend translation. */
export async function GET() {
  return Response.json(await listFrontendPbcRequests());
}

export async function POST(req: Request) {
  const sql = getSql();
  const body = await req.json();
  const id = randomUUID();
  await sql`
    INSERT INTO pbc_requests (id, item_type, description, due_date, owner_name, status, linked_invoice_ids)
    VALUES (${id}, ${body.itemType ?? "invoice_bundle"}, ${body.description}, ${body.dueDate ?? null}, ${body.requestedBy ?? "Unassigned"}, 'open', ${(body.linkedInvoiceIds ?? []).join(",")})
  `;
  return Response.json({ success: true, id });
}
