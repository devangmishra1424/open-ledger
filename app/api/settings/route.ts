import { getSql } from "@/db/client";

/** GET/PUT /api/settings — real persistence (app_settings, single 'default' row). See db/schema.sql's note: not yet read by the live policy engine. */
export async function GET() {
  const sql = getSql();
  const rows = await sql`SELECT auto_approval_confidence, max_auto_payment_amount, erp_webhook_url FROM app_settings WHERE id = 'default'`;
  if (rows.length === 0) {
    return Response.json({ autoApprovalConfidence: 95.0, maxAutoPaymentAmount: 50000.0, erpWebhookUrl: "" });
  }
  const r = rows[0];
  return Response.json({
    autoApprovalConfidence: r.auto_approval_confidence,
    maxAutoPaymentAmount: r.max_auto_payment_amount,
    erpWebhookUrl: r.erp_webhook_url ?? "",
  });
}

export async function PUT(req: Request) {
  const sql = getSql();
  const body = await req.json().catch(() => ({}));

  await sql`
    UPDATE app_settings SET
      auto_approval_confidence = ${body.autoApprovalConfidence ?? 95.0},
      max_auto_payment_amount = ${body.maxAutoPaymentAmount ?? 50000.0},
      erp_webhook_url = ${body.erpWebhookUrl ?? null},
      updated_at = ${new Date().toISOString()}
    WHERE id = 'default'
  `;

  return Response.json({ success: true, ...body });
}
