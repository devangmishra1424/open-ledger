import type { BillStatus } from "@/lib/types";

/**
 * The one rulebook for which HUMAN action is allowed in which invoice state.
 *
 * Why this exists: Approve, Reject, Contest and "Mark all reviewed" used to flip
 * `vendor_bills.status` (or just log a review row) with no rules at all, so you could approve an
 * invoice that had been rejected, or reject one that was already posted to the ledger and leave
 * its journal entry behind. The status string is the only footprint a human action leaves on every
 * screen, so letting it change arbitrarily is how screens ended up disagreeing about what happened.
 *
 * Pure on purpose (no database, no I/O): every route calls this before it touches anything, and the
 * UI can call it to decide which buttons to show, so the two can never drift apart.
 *
 * Status vocabulary is the one in db/schema.sql's CHECK constraint (lib/types.ts BillStatus).
 */

export type HumanAction = "approve" | "reject" | "contest" | "mark_reviewed";

export type ActionCheck =
  /** `alreadyDone`: the invoice is already in the state this action would produce — succeed without redoing anything (safe to retry). */
  | { allowed: true; alreadyDone: boolean }
  | { allowed: false; reason: string };

export interface ActionContext {
  /**
   * A bank-detail change on this vendor has not yet cleared its callback / second-reviewer
   * verification (lib/ledger/bank-change-review.ts). Money must not move while it is true.
   */
  bankChangeHold?: boolean;
}

const OPEN_FOR_REVIEW: BillStatus[] = ["exception", "matched"];
const ALREADY_APPROVED: BillStatus[] = ["approved", "posted", "paid"];

/** Why an action is refused, per state — written for the person who clicked, not for a developer. */
const REFUSAL: Record<BillStatus, string> = {
  processing: "this invoice is still being processed — wait for the result before acting on it",
  matched: "",
  exception: "",
  approved: "this invoice is already approved and posted to the ledger",
  posted: "this invoice is already posted to the ledger — reverse the entry instead of changing the decision",
  paid: "this invoice has already been paid",
  void: "this invoice was rejected — contest it if the rejection was a mistake",
};

export function checkHumanAction(status: BillStatus, action: HumanAction, ctx: ActionContext = {}): ActionCheck {
  switch (action) {
    case "approve": {
      if (ALREADY_APPROVED.includes(status)) return { allowed: true, alreadyDone: true };
      if (!OPEN_FOR_REVIEW.includes(status)) return { allowed: false, reason: REFUSAL[status] };
      if (ctx.bankChangeHold) {
        return { allowed: false, reason: "the vendor's bank details changed and are not verified yet — complete the callback check first" };
      }
      return { allowed: true, alreadyDone: false };
    }
    case "reject": {
      if (status === "void") return { allowed: true, alreadyDone: true };
      if (!OPEN_FOR_REVIEW.includes(status)) return { allowed: false, reason: REFUSAL[status] };
      return { allowed: true, alreadyDone: false };
    }
    case "contest": {
      // An invoice can be contested while it is open or after it was rejected; never once it is
      // posted/paid (the ledger already reflects it) or while the pipeline is still running.
      if (status === "exception" || status === "matched" || status === "void") return { allowed: true, alreadyDone: false };
      return { allowed: false, reason: REFUSAL[status] };
    }
    case "mark_reviewed": {
      if (status === "exception") return { allowed: true, alreadyDone: false };
      return { allowed: false, reason: "only invoices waiting on a human can be marked reviewed" };
    }
  }
}

/** The buttons a case card should offer right now. `mark_reviewed` is a bulk dashboard action, not a per-invoice button. */
export function allowedActions(status: BillStatus, ctx: ActionContext = {}): Exclude<HumanAction, "mark_reviewed">[] {
  const candidates: Exclude<HumanAction, "mark_reviewed">[] = ["approve", "reject", "contest"];
  return candidates.filter((a) => {
    const check = checkHumanAction(status, a, ctx);
    return check.allowed && !check.alreadyDone;
  });
}
