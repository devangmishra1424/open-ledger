import { getSql } from "@/db/client";

/**
 * The two guardrails on the Settings screen, read by the policy engine on every decision:
 *  - maxAutoPaymentAmount: an invoice above this is never auto-approved, however clean the match.
 *  - autoApprovalConfidence (0-100): the Investigator's reported confidence must reach this for an
 *    auto-approval to stand.
 * Both can only make the system MORE cautious (an auto-approval becomes a human review); neither
 * can approve anything the rules would not. A missing settings row falls back to these defaults
 * (the same ones db/schema.sql declares) rather than failing a pipeline run.
 */
export interface PolicyLimits {
  autoApprovalConfidence: number;
  maxAutoPaymentAmount: number;
}

// 90, not higher: measured on live runs, the Investigator reports 0.93-0.98 on clean matches, so a 95 default would hold a meaningful share of perfectly clean invoices.
export const DEFAULT_POLICY_LIMITS: PolicyLimits = { autoApprovalConfidence: 90, maxAutoPaymentAmount: 50_000 };

export async function getPolicyLimits(): Promise<PolicyLimits> {
  const rows = await getSql()`SELECT auto_approval_confidence, max_auto_payment_amount FROM app_settings WHERE id = 'default'`;
  if (rows.length === 0) return DEFAULT_POLICY_LIMITS;
  return {
    autoApprovalConfidence: Number(rows[0].auto_approval_confidence),
    maxAutoPaymentAmount: Number(rows[0].max_auto_payment_amount),
  };
}

export interface GuardrailInput {
  amount: number;
  /** The Investigator's reported confidence, 0-1; undefined when no investigation ran. */
  investigatorConfidence?: number;
}

/** Pure: the reason an auto-approval must instead go to a person, or null if it stands. */
export function guardrailBreach(input: GuardrailInput, limits: PolicyLimits): string | null {
  if (input.amount > limits.maxAutoPaymentAmount) {
    return `Amount ${input.amount.toFixed(2)} is over the auto-approval limit of ${limits.maxAutoPaymentAmount.toFixed(2)}`;
  }
  if (input.investigatorConfidence !== undefined && input.investigatorConfidence * 100 < limits.autoApprovalConfidence) {
    return `Investigator confidence ${(input.investigatorConfidence * 100).toFixed(0)}% is below the auto-approval threshold of ${limits.autoApprovalConfidence}%`;
  }
  return null;
}
