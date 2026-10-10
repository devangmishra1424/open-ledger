import { getFrontendInvoiceDetail } from "@/lib/api-shapes";
import { handle } from "@/lib/http";

/** GET /api/invoices/:id — the full case: the list view of the invoice plus the three-way comparison (ordered / received / invoiced) and reason names. */
export const GET = handle("GET /api/invoices/:id", async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const invoice = await getFrontendInvoiceDetail(id);
  if (!invoice) return Response.json({ error: `no invoice found with id '${id}'` }, { status: 404 });
  return Response.json(invoice);
});
