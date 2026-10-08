import { randomUUID } from "node:crypto";
import { logCallbackAttempt } from "@/lib/ledger/bank-change-review";

/**
 * Starts the vendor callback for a bank-detail change: the control that stops "your supplier's
 * bank account changed" payment fraud. The ONLY thing this does is log that a callback attempt
 * is happening (which number, who is making it) and hand back the script to read out. It never
 * decides the outcome.
 *
 * The earlier version called a voice provider and then ALWAYS recorded the outcome as
 * "confirmed" — whether the call connected, failed, or was never placed (no API key → "mock
 * success"). That turned the fraud control into a button that approves itself. The outcome is
 * now recorded separately (POST /api/reviews/:id/outcome) by the person who made the call, and
 * a different reviewer must then sign off (maker/checker, lib/ledger/bank-change-review.ts).
 *
 * No automated call is placed: an outbound voice-agent integration has to deliver the vendor's
 * actual answer (a verified webhook with the call result) before it may record "confirmed".
 */
export interface CallbackStart {
  callId: string;
  status: "awaiting_outcome";
  /** Always true today: no automated call is placed; the reviewer phones the vendor themselves. */
  simulated: true;
  script: string;
}

const PHONE = /^\+?[0-9][0-9 ()-]{6,19}$/;

export function isPlausiblePhone(value: string): boolean {
  return PHONE.test(value.trim());
}

export function callbackScript(vendorName: string, oldLast4?: string, newLast4?: string): string {
  const change = oldLast4 || newLast4 ? ` (account ending ${oldLast4 ?? "????"} changed to ending ${newLast4 ?? "????"})` : "";
  return `Call ${vendorName} on a phone number from your own vendor master file or a previous trusted invoice — NOT a number from the change request or the new invoice. Ask them to confirm they asked to change their bank details${change}. Record exactly what they said.`;
}

export async function startVendorCallback(reviewId: string, phoneNumber: string, vendorName: string, reviewerName: string, banks?: { oldLast4?: string; newLast4?: string }): Promise<CallbackStart> {
  if (!isPlausiblePhone(phoneNumber)) throw new Error("phoneNumber must be the number you are dialing (digits, +, spaces, brackets, dashes)");
  await logCallbackAttempt({ reviewId, phoneUsed: phoneNumber.trim(), confirmedBy: reviewerName });
  return { callId: randomUUID(), status: "awaiting_outcome", simulated: true, script: callbackScript(vendorName, banks?.oldLast4, banks?.newLast4) };
}
