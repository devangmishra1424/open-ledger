import { getSql } from "@/db/client";
import { getPolicyLimits } from "@/lib/settings";
import { handle, HttpError, readJsonBody } from "@/lib/http";

/**
 * GET/PUT /api/settings — the two policy guardrails (lib/settings.ts), which the policy engine
 * reads on every decision. PUT takes either or both: { autoApprovalConfidence: 0-100,
 * maxAutoPaymentAmount: >= 0 }. (A third field, an ERP webhook URL, used to be stored here but
 * nothing ever called it; it was removed rather than left as a setting that does nothing.)
 */
export const GET = handle("GET /api/settings", async () => {
  return Response.json(await getPolicyLimits());
});

function optionalNumber(body: Record<string, unknown>, key: string, min: number, max: number): number | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new HttpError(400, `${key} must be a number from ${min} to ${max}`);
  return v;
}

export const PUT = handle("PUT /api/settings", async (req) => {
  const body = await readJsonBody(req);
  const confidence = optionalNumber(body, "autoApprovalConfidence", 0, 100);
  const maxAmount = optionalNumber(body, "maxAutoPaymentAmount", 0, 1e12);
  if (confidence === null && maxAmount === null) throw new HttpError(400, "send autoApprovalConfidence and/or maxAutoPaymentAmount");

  await getSql()`
    INSERT INTO app_settings (id, auto_approval_confidence, max_auto_payment_amount, updated_at)
    VALUES ('default', COALESCE(${confidence}::real, 90.0), COALESCE(${maxAmount}::real, 50000.0), ${new Date().toISOString()})
    ON CONFLICT (id) DO UPDATE SET
      auto_approval_confidence = COALESCE(${confidence}::real, app_settings.auto_approval_confidence),
      max_auto_payment_amount = COALESCE(${maxAmount}::real, app_settings.max_auto_payment_amount),
      updated_at = EXCLUDED.updated_at`;
  return Response.json({ success: true, ...(await getPolicyLimits()) });
});
