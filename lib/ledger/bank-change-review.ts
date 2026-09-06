import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { getSql } from "@/db/client";
import type { VendorBankChangeReview } from "@/lib/types";

/**
 * ALGORITHMS.md §6's gated bank-change workflow, standalone: flagged -> callback_pending ->
 * callback_confirmed | callback_failed, maker/checker enforced on the confirmed path.
 * INTEGRATION.md §3 notes the `vendor_bank_change_reviews` table and decision-matrix.ts's
 * `evaluateFraudBank()` both already exist but nothing detects a bank change or drives this
 * state machine — this file is that missing piece. Deliberately self-contained: whoever wires
 * this into lib/pipeline/match-stage.ts / orchestrator.ts owns that call site, not this file.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * "Recent" window for treating a vendor's bank_account_changed_at as still gating its
 * invoices. ALGORITHMS.md §6 itself doesn't name a number for this. This project's own
 * matching spec does, for the same real-world signal: docs/ap-three-way-match-spec.md's
 * EXC-FRAUD_BANK detection logic (EXC-12) fires on "vendor bank details updated within last
 * 30 days AND invoice amount > $5,000" — 30 days is reused here as the one "recent" figure
 * the spec set actually commits to, rather than inventing an unrelated one.
 *
 * Deliberately distinct from CALLBACK_ABANDONMENT_TIMEOUT_MS below: that's a demo-scaled UI
 * timeout for an open review sitting in callback_pending, not a detection window for whether
 * a bank change is fresh enough to flag in the first place. Conflating the two was flagged
 * explicitly in the task brief as a risk to avoid.
 */
export const BANK_CHANGE_RECENT_WINDOW_DAYS = 30;

/** ALGORITHMS.md §6: "abandoned after a timeout (demo-scaled, e.g. 15 minutes)". */
export const CALLBACK_ABANDONMENT_TIMEOUT_MS = 15 * 60 * 1000;

/** Fixed advisory-lock key for this table's writes — same rationale as journal.ts's JOURNAL_LOCK_KEY / decisions.ts's HASH_CHAIN_LOCK_KEY: serializes check-then-write races without a manual unlock to forget. */
const REVIEW_LOCK_KEY = 5647382910;

function fromRow(row: any): VendorBankChangeReview {
  return {
    id: row.id,
    vendorId: row.vendor_id,
    oldBankLast4: row.old_bank_last4 ?? undefined,
    newBankLast4: row.new_bank_last4 ?? undefined,
    status: row.status,
    callbackPhoneUsed: row.callback_phone_used ?? undefined,
    callbackConfirmedBy: row.callback_confirmed_by ?? undefined,
    callbackAt: row.callback_at ?? undefined,
    secondReviewerName: row.second_reviewer_name ?? undefined,
    sourceInvoiceId: row.source_invoice_id ?? undefined,
    createdAt: row.created_at,
  };
}

async function getReviewOrThrow(sql: Sql<{}> | TransactionSql<{}>, reviewId: string): Promise<VendorBankChangeReview> {
  const rows = await sql`SELECT * FROM vendor_bank_change_reviews WHERE id = ${reviewId}`;
  if (rows.length === 0) throw new Error(`no vendor_bank_change_reviews row found with id '${reviewId}'`);
  return fromRow(rows[0]);
}

function requireNonBlank(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${label} must be a non-blank string`);
  return trimmed;
}

/** Case/whitespace-insensitive so 'Alice' vs ' alice ' still trips the maker/checker guard. */
function normalizeReviewerName(name: string): string {
  return name.trim().toLowerCase();
}

async function flagVendorAsFlagged(sql: Sql<{}> | TransactionSql<{}>, vendorId: string): Promise<void> {
  await sql`UPDATE vendors SET trust_tier = 'flagged' WHERE id = ${vendorId} AND trust_tier != 'flagged'`;
}

export async function getBankChangeReview(reviewId: string): Promise<VendorBankChangeReview | undefined> {
  const rows = await getSql()`SELECT * FROM vendor_bank_change_reviews WHERE id = ${reviewId}`;
  return rows.length > 0 ? fromRow(rows[0]) : undefined;
}

export type BankChangeGateStatus = "flagged" | "callback_pending" | "callback_confirmed" | "callback_failed" | "cleared";

export interface BankChangeGateCheck {
  /** true if an invoice for this vendor should be held pending resolution of the bank change. */
  gating: boolean;
  status: BankChangeGateStatus;
  review?: VendorBankChangeReview;
  bankAccountChangedAt?: string;
}

/**
 * Function 1 — does this vendor have an unconfirmed recent bank change that should gate its
 * invoices right now?
 *
 * Two resolutions for gaps ALGORITHMS.md §6 leaves open, stated explicitly rather than picked
 * silently:
 *  - A gate only clears once a review is BOTH callback_confirmed AND has a distinct
 *    second_reviewer_name — "confirmed" alone is not enough, matching §6's own sentence order
 *    ("requires a second, different reviewer's sign-off ... before ... the invoice re-enters
 *    normal processing").
 *  - The recent-window check (BANK_CHANGE_RECENT_WINDOW_DAYS) only governs whether a bank
 *    change with NO review row yet counts as a fresh 'flagged' signal. Once a review row
 *    exists, its own status governs regardless of how much time has passed — a callback_failed
 *    review must stay gating ("permanently blocked" per §6) even after the recent-window has
 *    elapsed; re-running the window check against an old failed review would silently
 *    un-block it, which is the opposite of what §6 asks for.
 */
export async function detectBankChangeGate(vendorId: string): Promise<BankChangeGateCheck> {
  const sql = getSql();
  const vendorRows = await sql`SELECT id, bank_account_last4, bank_account_changed_at FROM vendors WHERE id = ${vendorId}`;
  if (vendorRows.length === 0) throw new Error(`detectBankChangeGate: no vendor found with id '${vendorId}'`);
  const vendor = vendorRows[0];

  if (!vendor.bank_account_changed_at) {
    return { gating: false, status: "cleared" };
  }
  const bankAccountChangedAt: string = vendor.bank_account_changed_at;

  const reviewRows = await sql`
    SELECT * FROM vendor_bank_change_reviews
    WHERE vendor_id = ${vendorId} AND new_bank_last4 IS NOT DISTINCT FROM ${vendor.bank_account_last4}
    ORDER BY created_at DESC LIMIT 1
  `;

  if (reviewRows.length > 0) {
    const review = fromRow(reviewRows[0]);
    if (review.status === "callback_confirmed" && review.secondReviewerName) {
      return { gating: false, status: "cleared", review, bankAccountChangedAt };
    }
    return { gating: true, status: review.status, review, bankAccountChangedAt };
  }

  const changedAtMs = new Date(bankAccountChangedAt).getTime();
  const isRecent = !Number.isNaN(changedAtMs) && Date.now() - changedAtMs <= BANK_CHANGE_RECENT_WINDOW_DAYS * MS_PER_DAY;
  if (isRecent) {
    return { gating: true, status: "flagged", bankAccountChangedAt };
  }
  return { gating: false, status: "cleared", bankAccountChangedAt };
}

export interface CreateBankChangeReviewInput {
  vendorId: string;
  oldBankLast4?: string | null;
  newBankLast4?: string | null;
  sourceInvoiceId?: string | null;
}

export interface CreateBankChangeReviewResult {
  review: VendorBankChangeReview;
  /** false if an existing row for this vendor+bank-change was found instead of inserting. */
  created: boolean;
}

/**
 * Function 2 — idempotently create the review row on first detection. Idempotency key is
 * (vendor_id, new_bank_last4): a second detection call for the same vendor and the same new
 * bank details finds the existing row rather than inserting a duplicate, however many times
 * the pipeline re-runs detection for this invoice/vendor. Guarded by a transaction-scoped
 * advisory lock (same pattern as journal.ts/decisions.ts) so two concurrent detections can't
 * both pass the pre-check and double-insert.
 */
export async function getOrCreateBankChangeReview(input: CreateBankChangeReviewInput): Promise<CreateBankChangeReviewResult> {
  const sql = getSql();
  const newBankLast4 = input.newBankLast4 ?? null;

  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${REVIEW_LOCK_KEY})`;

    const vendorRows = await tx`SELECT id FROM vendors WHERE id = ${input.vendorId}`;
    if (vendorRows.length === 0) throw new Error(`getOrCreateBankChangeReview: no vendor found with id '${input.vendorId}'`);

    const existing = await tx`
      SELECT * FROM vendor_bank_change_reviews
      WHERE vendor_id = ${input.vendorId} AND new_bank_last4 IS NOT DISTINCT FROM ${newBankLast4}
      ORDER BY created_at DESC LIMIT 1
    `;
    if (existing.length > 0) return { review: fromRow(existing[0]), created: false };

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    await tx`
      INSERT INTO vendor_bank_change_reviews
        (id, vendor_id, old_bank_last4, new_bank_last4, status, source_invoice_id, created_at)
      VALUES (${id}, ${input.vendorId}, ${input.oldBankLast4 ?? null}, ${newBankLast4}, 'callback_pending', ${input.sourceInvoiceId ?? null}, ${createdAt})
    `;
    const rows = await tx`SELECT * FROM vendor_bank_change_reviews WHERE id = ${id}`;
    return { review: fromRow(rows[0]), created: true };
  });
}

export interface LogCallbackAttemptInput {
  reviewId: string;
  phoneUsed: string;
  confirmedBy: string;
  /** Defaults to now — pass explicitly only in tests that need a fixed timestamp. */
  callbackAt?: string;
}

/**
 * Function 3 — log a callback attempt: phone number used, who made/received the call, when.
 * Only valid while the review is still callback_pending; logging a callback against an
 * already-resolved review would silently rewrite an audit fact after the fact.
 */
export async function logCallbackAttempt(input: LogCallbackAttemptInput): Promise<VendorBankChangeReview> {
  const sql = getSql();
  const phoneUsed = requireNonBlank(input.phoneUsed, "phoneUsed");
  const confirmedBy = requireNonBlank(input.confirmedBy, "confirmedBy");

  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${REVIEW_LOCK_KEY})`;
    const review = await getReviewOrThrow(tx, input.reviewId);
    if (review.status !== "callback_pending") {
      throw new Error(`logCallbackAttempt: review '${input.reviewId}' is '${review.status}', not 'callback_pending'`);
    }
    const callbackAtRaw = input.callbackAt;
    const callbackAt = callbackAtRaw ? requireNonBlank(callbackAtRaw, "callbackAt") : new Date().toISOString();
    if (Number.isNaN(Date.parse(callbackAt))) {
      throw new Error(`callbackAt must be a valid ISO timestamp`);
    }
    await tx`
      UPDATE vendor_bank_change_reviews
      SET callback_phone_used = ${phoneUsed}, callback_confirmed_by = ${confirmedBy}, callback_at = ${callbackAt}
      WHERE id = ${input.reviewId}
    `;
    return getReviewOrThrow(tx, input.reviewId);
  });
}

export type CallbackOutcome = "confirmed" | "failed";

/**
 * Function 4 — record the callback's outcome.
 *
 * A 'confirmed' outcome requires a callback attempt to already be logged (function 3) — you
 * cannot confirm a call that was never made. A 'failed' outcome does NOT require one: a
 * logged-but-unsuccessful callback (wrong number, vendor denies the change) and a callback
 * that was simply never attempted both legitimately end in 'failed' — the latter is exactly
 * what an abandoned review looks like (see checkAbandonmentTimeout below), and ALGORITHMS.md
 * §6 treats "failed" and "abandoned after a timeout" as the same terminal outcome (invoice
 * stays permanently blocked, vendor flips to trust_tier='flagged') rather than two.
 *
 * 'confirmed' is NOT itself terminal — it still needs the second-reviewer sign-off
 * (recordSecondReviewerSignOff) before the gate actually clears.
 */
export async function recordCallbackOutcome(reviewId: string, outcome: CallbackOutcome): Promise<VendorBankChangeReview> {
  const sql = getSql();

  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${REVIEW_LOCK_KEY})`;
    const review = await getReviewOrThrow(tx, reviewId);
    if (review.status !== "callback_pending") {
      throw new Error(`recordCallbackOutcome: review '${reviewId}' is '${review.status}', not 'callback_pending'`);
    }
    if (outcome === "confirmed" && (!review.callbackConfirmedBy || !review.callbackAt)) {
      throw new Error(`recordCallbackOutcome: cannot confirm review '${reviewId}' without a logged callback attempt`);
    }

    const status: VendorBankChangeReview["status"] = outcome === "confirmed" ? "callback_confirmed" : "callback_failed";
    await tx`UPDATE vendor_bank_change_reviews SET status = ${status} WHERE id = ${reviewId}`;

    if (outcome === "failed") {
      await flagVendorAsFlagged(tx, review.vendorId);
    }

    return getReviewOrThrow(tx, reviewId);
  });
}

/**
 * Function 5 — the second, DIFFERENT reviewer's sign-off. This is the maker/checker invariant
 * ALGORITHMS.md §6 requires before a confirmed bank change is trusted: throws, always, if
 * secondReviewerName matches the callback-logging reviewer (callback_confirmed_by) — this is
 * the entire point of the function and must never be silently bypassable by a caller that
 * forgets to check first. Comparison is case/whitespace-insensitive so trivial formatting
 * differences can't slip the same person past the check.
 */
export async function recordSecondReviewerSignOff(reviewId: string, secondReviewerName: string): Promise<VendorBankChangeReview> {
  const sql = getSql();
  const signOffName = requireNonBlank(secondReviewerName, "secondReviewerName");

  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${REVIEW_LOCK_KEY})`;
    const review = await getReviewOrThrow(tx, reviewId);

    if (review.status !== "callback_confirmed") {
      throw new Error(`recordSecondReviewerSignOff: review '${reviewId}' is '${review.status}', not 'callback_confirmed'`);
    }
    if (review.secondReviewerName) {
      throw new Error(`recordSecondReviewerSignOff: review '${reviewId}' already has a second-reviewer sign-off ('${review.secondReviewerName}')`);
    }
    if (!review.callbackConfirmedBy) {
      throw new Error(`recordSecondReviewerSignOff: review '${reviewId}' has no callback_confirmed_by on file to check against`);
    }
    if (normalizeReviewerName(signOffName) === normalizeReviewerName(review.callbackConfirmedBy)) {
      throw new Error(
        `recordSecondReviewerSignOff: maker/checker violation — '${secondReviewerName}' cannot sign off on the bank change they themselves confirmed via callback (review '${reviewId}')`
      );
    }

    await tx`UPDATE vendor_bank_change_reviews SET second_reviewer_name = ${signOffName} WHERE id = ${reviewId}`;
    return getReviewOrThrow(tx, reviewId);
  });
}

export interface AbandonmentCheckResult {
  abandoned: boolean;
  /** Whether the caller should now flip the vendor to trust_tier='flagged' (per §6, same consequence as an explicit 'failed' outcome). */
  shouldFlagVendor: boolean;
  elapsedMs: number;
}

/**
 * Function 6 — has the 15-minute (demo-scaled) callback_pending abandonment timeout elapsed?
 *
 * Deliberately a pure check, no mutation: it reports the timeout state rather than acting on
 * it. ALGORITHMS.md §6 folds "failed" and "abandoned after a timeout" into the same terminal
 * consequence, so a caller that sees shouldFlagVendor: true should call
 * recordCallbackOutcome(reviewId, 'failed') (function 4) to actually perform that transition —
 * kept separate here so the *decision* to treat a slow reviewer as abandoned (rather than,
 * say, extending their time) stays with whoever is orchestrating the workflow, not forced by a
 * status check that runs on every poll.
 */
export async function checkAbandonmentTimeout(reviewId: string): Promise<AbandonmentCheckResult> {
  const sql = getSql();
  const review = await getReviewOrThrow(sql, reviewId);
  const elapsedMs = Date.now() - new Date(review.createdAt).getTime();

  if (review.status !== "callback_pending") {
    return { abandoned: false, shouldFlagVendor: false, elapsedMs };
  }

  const abandoned = elapsedMs > CALLBACK_ABANDONMENT_TIMEOUT_MS;
  return { abandoned, shouldFlagVendor: abandoned, elapsedMs };
}
