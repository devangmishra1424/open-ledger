import { getSql } from "@/db/client";
import { getPolicyLimits, parseCurrencyLimits } from "@/lib/settings";
import { handle, HttpError, readJsonBody } from "@/lib/http";

/**
 * GET/PUT /api/settings — the policy guardrails (lib/settings.ts), which the policy engine
 * reads on every decision. PUT takes any of: { autoApprovalConfidence: 0-100,
 * maxAutoPaymentAmount: >= 0 (USD), currencyLimits: { "INR": 4000000, ... } (replaces the whole set) }. (A third field, an ERP webhook URL, used to be stored here but
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
  let currencyLimits: string | null = null;
  if (body.currencyLimits !== undefined && body.currencyLimits !== null) {
    try {
      const parsed = parseCurrencyLimits(body.currencyLimits);
      if (Object.values(parsed).some((v) => v > 1e15)) throw new Error("a limit is too large");
      delete parsed.USD; // the USD limit is maxAutoPaymentAmount
      currencyLimits = JSON.stringify(parsed);
    } catch (e) {
      throw new HttpError(400, `currencyLimits must be { "INR": 4000000, ... } with 3-letter codes and numbers of 0 or more (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  if (confidence === null && maxAmount === null && currencyLimits === null) throw new HttpError(400, "send autoApprovalConfidence, maxAutoPaymentAmount and/or currencyLimits");

  await getSql()`
    INSERT INTO app_settings (id, auto_approval_confidence, max_auto_payment_amount, currency_limits, updated_at)
    VALUES ('default', COALESCE(${confidence}::real, 90.0), COALESCE(${maxAmount}::numeric, 50000.0), COALESCE(${currencyLimits}, '{"INR": 4000000}'), ${new Date().toISOString()})
    ON CONFLICT (id) DO UPDATE SET
      auto_approval_confidence = COALESCE(${confidence}::real, app_settings.auto_approval_confidence),
      max_auto_payment_amount = COALESCE(${maxAmount}::numeric, app_settings.max_auto_payment_amount),
      currency_limits = COALESCE(${currencyLimits}, app_settings.currency_limits),
      updated_at = EXCLUDED.updated_at`;
  return Response.json({ success: true, ...(await getPolicyLimits()) });
});
