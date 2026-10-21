import { getSql } from "@/db/client";

/**
 * The two guardrails on the Settings screen, read by the policy engine on every decision:
 *  - maxAutoPaymentAmount: a USD invoice above this is never auto-approved, however clean the match;
 *    currencyLimits holds the same limit for other currencies ({"INR": 4000000}). There are no exchange rates in
 *    the system, so an invoice in a currency with no limit set always goes to a person (migration 010).
 *  - autoApprovalConfidence (0-100): the Investigator's reported confidence must reach this for an
 *    auto-approval to stand.
 * Both can only make the system MORE cautious (an auto-approval becomes a human review); neither
 * can approve anything the rules would not. A missing settings row falls back to these defaults
 * (the same ones db/schema.sql declares) rather than failing a pipeline run.
 */
export interface PolicyLimits {
  autoApprovalConfidence: number;
  /** The USD limit. */
  maxAutoPaymentAmount: number;
  /** Limits for other currencies, by ISO code. */
  currencyLimits: Record<string, number>;
}

// 90, not higher: measured on live runs, the Investigator reports 0.93-0.98 on clean matches, so a 95 default would hold a meaningful share of perfectly clean invoices.
export const DEFAULT_POLICY_LIMITS: PolicyLimits = { autoApprovalConfidence: 90, maxAutoPaymentAmount: 50_000, currencyLimits: { INR: 4_000_000 } };

/** The stored JSON, validated: ISO code -> a positive number. Anything else in it is a data fault and is refused. */
export function parseCurrencyLimits(raw: unknown): Record<string, number> {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("app_settings.currency_limits is not a JSON object");
  const out: Record<string, number> = {};
  for (const [code, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[A-Z]{3}$/.test(code) || typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`app_settings.currency_limits has a bad entry: ${code}=${String(value)}`);
    }
    out[code] = value;
  }
  return out;
}

/** The auto-approval limit for one currency, or null when none is set for it. */
export function limitFor(currency: string, limits: PolicyLimits): number | null {
  if (currency === "USD") return limits.maxAutoPaymentAmount;
  return limits.currencyLimits[currency] ?? null;
}

export async function getPolicyLimits(): Promise<PolicyLimits> {
  const rows = await getSql()`SELECT auto_approval_confidence, max_auto_payment_amount, currency_limits FROM app_settings WHERE id = 'default'`;
  if (rows.length === 0) return DEFAULT_POLICY_LIMITS;
  return {
    autoApprovalConfidence: Number(rows[0].auto_approval_confidence),
    maxAutoPaymentAmount: Number(rows[0].max_auto_payment_amount),
    currencyLimits: parseCurrencyLimits(rows[0].currency_limits),
  };
}

export interface GuardrailInput {
  amount: number;
  /** ISO code; defaults to USD. */
  currency?: string;
  /** The Investigator's reported confidence, 0-1; undefined when no investigation ran. */
  investigatorConfidence?: number;
}

/** Pure: the reason an auto-approval must instead go to a person, or null if it stands. */
export function guardrailBreach(input: GuardrailInput, limits: PolicyLimits): string | null {
  const currency = input.currency ?? "USD";
  const limit = limitFor(currency, limits);
  if (limit === null) {
    return `No auto-approval limit is set for ${currency} invoices (Settings), so a person decides`;
  }
  if (input.amount > limit) {
    return `Amount ${currency === "USD" ? "" : `${currency} `}${input.amount.toFixed(2)} is over the auto-approval limit of ${limit.toFixed(2)}${currency === "USD" ? "" : ` ${currency}`}`;
  }
  if (input.investigatorConfidence !== undefined && input.investigatorConfidence * 100 < limits.autoApprovalConfidence) {
    return `Investigator confidence ${(input.investigatorConfidence * 100).toFixed(0)}% is below the auto-approval threshold of ${limits.autoApprovalConfidence}%`;
  }
  return null;
}
