import { getFrontendInvoice } from "@/lib/api-shapes";

/** GET /api/invoices/:id — the frontend-shaped invoice, including its real per-stage decisions array (lib/api-shapes.ts's FrontendInvoice.decisions) for the swimlane/"Ask Why" UI. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invoice = await getFrontendInvoice(id);
  if (!invoice) return Response.json({ error: `no invoice found with id '${id}'` }, { status: 404 });
  return Response.json(invoice);
}
