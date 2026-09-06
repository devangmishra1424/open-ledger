import { getSql } from "@/db/client";
import { extract } from "@/lib/agent/extractor";
import { runPipeline } from "@/lib/pipeline/orchestrator";
import { getFrontendInvoice } from "@/lib/api-shapes";

/**
 * POST /api/invoices/ingest — the real document-ingestion path: takes raw, unstructured
 * invoice text (what you'd get from an uploaded .txt/email/OCR dump) and runs it through the
 * real Extraction Agent (lib/agent/extractor.ts, a real OpenAI call) to pull out vendor,
 * invoice number, PO reference, and line items — then hands the result to the same real
 * pipeline every other invoice goes through. This is the one real LLM extraction call; once
 * the lines exist, runPipeline's own extract stage takes the deterministic "already parsed"
 * path (lib/pipeline/orchestrator.ts's runExtractStage), same as every structured demo fixture.
 *
 * Body: { rawText: string, vendorName?: string } — vendorName is a fallback only, used when
 * the extractor couldn't read a vendor name off the document itself.
 */
export async function POST(req: Request) {
  const sql = getSql();
  const body = await req.json().catch(() => ({}));
  const rawText: string = body.rawText ?? "";
  if (!rawText.trim()) {
    return Response.json({ error: "rawText is required — nothing to ingest" }, { status: 400 });
  }

  const { submission, toolCalls } = await extract(rawText);

  const vendorName = submission.vendor_name ?? body.vendorName ?? "Unknown Vendor";
  const existingVendor = await sql`SELECT id FROM vendors WHERE name = ${vendorName}`;
  let vendorId: string;
  if (existingVendor.length > 0) {
    vendorId = existingVendor[0].id;
  } else {
    vendorId = crypto.randomUUID();
    await sql`INSERT INTO vendors (id, name, trust_tier) VALUES (${vendorId}, ${vendorName}, 'new')`;
  }

  let poId: string | null = null;
  if (submission.po_reference) {
    const poRows = await sql`SELECT id FROM purchase_orders WHERE po_number = ${submission.po_reference} AND vendor_id = ${vendorId}`;
    poId = poRows[0]?.id ?? null; // not found -> genuinely non-PO, not fabricated
  }

  const lineItems = submission.line_items ?? [];
  const totalAmount = lineItems.length > 0
    ? lineItems.reduce((s, it) => s + it.quantity * it.unit_price, 0)
    : (submission.total ?? 0);

  const billId = crypto.randomUUID();
  const invoiceNumber = submission.invoice_number ?? `INGEST-${billId.slice(0, 8)}`;
  const today = new Date().toISOString().slice(0, 10);

  await sql`
    INSERT INTO vendor_bills (id, vendor_id, po_id, invoice_number, invoice_date, currency, subtotal, total_amount, raw_source)
    VALUES (${billId}, ${vendorId}, ${poId}, ${invoiceNumber}, ${submission.invoice_date ?? today},
      ${submission.currency ?? "USD"}, ${submission.subtotal ?? totalAmount}, ${totalAmount}, ${rawText})
  `;

  // A default expense account so an approval can actually post even when this line never
  // matches a PO line (postBillApproval's only other source for one) — found live: a clean
  // non-PO invoice reached auto_approve, then failed to post with no GL account anywhere to
  // fall back to, and sat in "error" instead of "posted".
  const defaultGlRows = await sql`SELECT id FROM chart_of_accounts WHERE account_number = '6000'`;
  const defaultGlAccountId: string | null = defaultGlRows[0]?.id ?? null;

  for (const item of lineItems) {
    await sql`
      INSERT INTO vendor_bill_lines (id, vendor_bill_id, description, qty_invoiced, unit_price, gl_account_id)
      VALUES (${crypto.randomUUID()}, ${billId}, ${item.description}, ${item.quantity}, ${item.unit_price}, ${defaultGlAccountId})
    `;
  }

  // Fire-and-forget — same pattern as POST /api/invoices.
  runPipeline(billId).catch((err) => console.error(`runPipeline failed for ingested bill ${billId}:`, err));

  const invoice = await getFrontendInvoice(billId);
  return Response.json({
    ...(invoice ?? { id: billId, status: "processing" }),
    extraction: {
      confidence: submission.confidence,
      uncertainFields: submission.uncertain_fields,
      toolCallCount: toolCalls.length,
    },
  }, { status: 201 });
}
