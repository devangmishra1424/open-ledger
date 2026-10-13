import { randomUUID } from "node:crypto";
import { getSql } from "@/db/client";
import { listFrontendPbcRequests } from "@/lib/pbc-shapes";
import { handle, HttpError, optionalString, readJsonBody, requireString, reviewerName } from "@/lib/http";

/** GET /api/pbc/requests, POST /api/pbc/requests — see lib/pbc-shapes.ts for the real<->frontend translation. */
export const GET = handle("GET /api/pbc/requests", async () => Response.json(await listFrontendPbcRequests()));

const MAX_LINKED_INVOICES = 200;

/**
 * POST /api/pbc/requests — record an auditor request.
 * Body: { description, requestedBy?, itemType?, dueDate?, linkedInvoiceIds?, reviewerName }.
 *
 * Only `invoice_bundle` is accepted: it is the one kind VeriBook can assemble evidence for. The
 * schema also names trial balances, AP aging and the like, but nothing builds those, so accepting
 * them would record a request the system can never answer. Every linked id must be a real invoice;
 * an unknown one used to be stored and then silently left out of the evidence.
 */
export const POST = handle("POST /api/pbc/requests", async (req) => {
  const body = await readJsonBody(req);
  const createdBy = reviewerName(body, req);
  const description = requireString(body, "description", { max: 300 });
  const requestedBy = optionalString(body, "requestedBy", { max: 120 }) ?? "Unassigned";

  const itemType = optionalString(body, "itemType", { max: 40 }) ?? "invoice_bundle";
  if (itemType !== "invoice_bundle") throw new HttpError(400, "itemType must be 'invoice_bundle': it is the only kind of request VeriBook can assemble evidence for");

  const dueDate = optionalString(body, "dueDate", { max: 10 });
  if (dueDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new HttpError(400, "dueDate must be a date like 2026-12-31");

  const raw = body.linkedInvoiceIds ?? [];
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string" || x.trim() === "")) throw new HttpError(400, "linkedInvoiceIds must be a list of invoice ids");
  const linkedIds = [...new Set((raw as string[]).map((x) => x.trim()))];
  if (linkedIds.length > MAX_LINKED_INVOICES) throw new HttpError(400, `a request can link at most ${MAX_LINKED_INVOICES} invoices`);

  const sql = getSql();
  if (linkedIds.length > 0) {
    const found = new Set((await sql`SELECT id FROM vendor_bills WHERE id = ANY(${linkedIds})`).map((r: any) => r.id));
    const unknown = linkedIds.filter((x) => !found.has(x));
    if (unknown.length > 0) throw new HttpError(400, `unknown invoice id${unknown.length === 1 ? "" : "s"}: ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? ", …" : ""}`);
  }

  const id = randomUUID();
  await sql`
    INSERT INTO pbc_requests (id, item_type, description, due_date, owner_name, status, linked_invoice_ids, created_by)
    VALUES (${id}, ${itemType}, ${description}, ${dueDate ?? null}, ${requestedBy}, 'open', ${linkedIds.join(",")}, ${createdBy})
  `;
  return Response.json({ success: true, id }, { status: 201 });
});
