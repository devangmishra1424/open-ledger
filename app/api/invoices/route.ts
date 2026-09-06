import { getSql } from "@/db/client";
import { runPipeline } from "@/lib/pipeline/orchestrator";
import { listFrontendInvoices, getFrontendInvoice } from "@/lib/api-shapes";

/** GET /api/invoices?status=Clean|In+Review|Blocked|In+Progress — real data, translated to the frontend's expected shape (see lib/api-shapes.ts). */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const statusParam = searchParams.get("status");
  // frontend statuses (Clean/In Review/...) don't map 1:1 to a single BillStatus value, so a
  // status filter is applied client-side today (InvoiceQueue.jsx already does this) — this
  // param is accepted for forward-compatibility but not required.
  void statusParam;
  const invoices = await listFrontendInvoices();
  return Response.json(invoices);
}

/**
 * POST /api/invoices — accepts the frontend's own create shape (vendor name, poNumber
 * string, items[]), resolves them to real ids, inserts real rows, and fires the real
 * pipeline. Also accepts the originally-planned CreateInvoiceRequest shape (rawSource +
 * optional vendorId/poId) for anything that sends structured data directly.
 */
export async function POST(req: Request) {
  const sql = getSql();
  const body = await req.json();

  let vendorId: string;
  if (body.vendorId) {
    vendorId = body.vendorId;
  } else {
    const vendorName: string = body.vendor ?? "Unknown Vendor";
    const existing = await sql`SELECT id FROM vendors WHERE name = ${vendorName}`;
    if (existing.length > 0) {
      vendorId = existing[0].id;
    } else {
      vendorId = crypto.randomUUID();
      await sql`INSERT INTO vendors (id, name, trust_tier) VALUES (${vendorId}, ${vendorName}, 'new')`;
    }
  }

  let poId: string | null = body.poId ?? null;
  if (!poId && body.poNumber) {
    const poRows = await sql`SELECT id FROM purchase_orders WHERE po_number = ${body.poNumber} AND vendor_id = ${vendorId}`;
    poId = poRows[0]?.id ?? null; // not found -> genuinely non-PO, not fabricated
  }

  const items: Array<{ description: string; qty: number; rate: number }> = Array.isArray(body.items) ? body.items : [];
  const totalAmount: number = items.length > 0
    ? items.reduce((s, it) => s + it.qty * it.rate, 0)
    : (body.totalAmount ?? body.amount ?? 0);

  const billId = crypto.randomUUID();
  const invoiceNumber = body.invoiceNumber ?? body.id ?? `INV-${Date.now()}`;
  const today = new Date().toISOString().slice(0, 10);

  await sql`
    INSERT INTO vendor_bills (id, vendor_id, po_id, invoice_number, invoice_date, due_date, currency, subtotal, total_amount, raw_source)
    VALUES (${billId}, ${vendorId}, ${poId}, ${invoiceNumber}, ${body.invoiceDate ?? today}, ${body.dueDate ?? null}, ${body.currency ?? "USD"}, ${totalAmount}, ${totalAmount}, ${body.rawSource ?? null})
  `;

  // A default expense account so an approval can actually post even when this line never
  // matches a PO line (postBillApproval's only other source for one).
  const defaultGlRows = await sql`SELECT id FROM chart_of_accounts WHERE account_number = '6000'`;
  const defaultGlAccountId: string | null = defaultGlRows[0]?.id ?? null;

  for (const item of items) {
    await sql`
      INSERT INTO vendor_bill_lines (id, vendor_bill_id, description, qty_invoiced, unit_price, gl_account_id)
      VALUES (${crypto.randomUUID()}, ${billId}, ${item.description}, ${item.qty}, ${item.rate}, ${defaultGlAccountId})
    `;
  }

  // Fire-and-forget — ENGINE.md §5: the pipeline runs async, this route returns immediately.
  runPipeline(billId).catch((err) => console.error(`runPipeline failed for ${billId}:`, err));

  const invoice = await getFrontendInvoice(billId);
  return Response.json(invoice ?? { id: billId, status: "processing" }, { status: 201 });
}
