import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getSql } from "@/db/client";
import {
  BANK_CHANGE_RECENT_WINDOW_DAYS,
  CALLBACK_ABANDONMENT_TIMEOUT_MS,
  detectBankChangeGate,
  getOrCreateBankChangeReview,
  logCallbackAttempt,
  recordCallbackOutcome,
  recordSecondReviewerSignOff,
  checkAbandonmentTimeout,
  getBankChangeReview,
} from "@/lib/ledger/bank-change-review";

/**
 * Live integration suite against the real Supabase DB — same prefix-and-cleanup convention as
 * tests/match-stage.test.ts / tests/journal.test.ts, since DATABASE_URL is available here.
 */

const PREFIX = "TEST-BANKCHANGE";
const sql = getSql();

const vendorIds: string[] = [];
const reviewIds: string[] = [];

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function makeVendor(opts: { bankAccountLast4?: string | null; bankAccountChangedAt?: string | null; trustTier?: string }) {
  const vendorId = crypto.randomUUID();
  vendorIds.push(vendorId);
  await sql`
    INSERT INTO vendors (id, name, bank_account_last4, bank_account_changed_at, trust_tier)
    VALUES (${vendorId}, ${PREFIX + " Vendor " + vendorId.slice(0, 8)}, ${opts.bankAccountLast4 ?? null}, ${opts.bankAccountChangedAt ?? null}, ${opts.trustTier ?? "new"})
  `;
  return vendorId;
}

async function vendorTrustTier(vendorId: string): Promise<string> {
  const rows = await sql`SELECT trust_tier FROM vendors WHERE id = ${vendorId}`;
  return rows[0].trust_tier;
}

afterAll(async () => {
  await sql`DELETE FROM vendor_bank_change_reviews WHERE id = ANY(${reviewIds})`;
  await sql`DELETE FROM vendor_bank_change_reviews WHERE vendor_id = ANY(${vendorIds})`;
  await sql`DELETE FROM vendors WHERE id = ANY(${vendorIds})`;
});

describe("named constants", () => {
  it("recent-window and abandonment-timeout are distinct, documented figures", () => {
    expect(BANK_CHANGE_RECENT_WINDOW_DAYS).toBe(30);
    expect(CALLBACK_ABANDONMENT_TIMEOUT_MS).toBe(15 * 60 * 1000);
  });
});

describe("detectBankChangeGate", () => {
  it("does not gate a vendor with no bank_account_changed_at on file", async () => {
    const vendorId = await makeVendor({});
    const result = await detectBankChangeGate(vendorId);
    expect(result).toEqual({ gating: false, status: "cleared" });
  });

  it("gates (status 'flagged') a vendor with a recent bank change and no review row yet", async () => {
    const vendorId = await makeVendor({ bankAccountLast4: "1111", bankAccountChangedAt: daysAgoIso(2) });
    const result = await detectBankChangeGate(vendorId);
    expect(result.gating).toBe(true);
    expect(result.status).toBe("flagged");
    expect(result.review).toBeUndefined();
  });

  it("does not gate a bank change older than the recent window, with no review row", async () => {
    const vendorId = await makeVendor({ bankAccountLast4: "2222", bankAccountChangedAt: daysAgoIso(BANK_CHANGE_RECENT_WINDOW_DAYS + 5) });
    const result = await detectBankChangeGate(vendorId);
    expect(result.gating).toBe(false);
    expect(result.status).toBe("cleared");
  });

  it("gates on an existing callback_pending review even if freshly created", async () => {
    const vendorId = await makeVendor({ bankAccountLast4: "3333", bankAccountChangedAt: daysAgoIso(1) });
    const { review } = await getOrCreateBankChangeReview({ vendorId, oldBankLast4: "9999", newBankLast4: "3333" });
    reviewIds.push(review.id);

    const result = await detectBankChangeGate(vendorId);
    expect(result.gating).toBe(true);
    expect(result.status).toBe("callback_pending");
    expect(result.review?.id).toBe(review.id);
  });

  it("clears once a review is callback_confirmed AND has a distinct second-reviewer sign-off", async () => {
    const vendorId = await makeVendor({ bankAccountLast4: "4444", bankAccountChangedAt: daysAgoIso(1) });
    const { review } = await getOrCreateBankChangeReview({ vendorId, oldBankLast4: "0000", newBankLast4: "4444" });
    reviewIds.push(review.id);
    await logCallbackAttempt({ reviewId: review.id, phoneUsed: "+1-555-0100", confirmedBy: "Alice Maker" });
    await recordCallbackOutcome(review.id, "confirmed");

    const stillGating = await detectBankChangeGate(vendorId);
    expect(stillGating.gating).toBe(true);
    expect(stillGating.status).toBe("callback_confirmed");

    await recordSecondReviewerSignOff(review.id, "Bob Checker");
    const cleared = await detectBankChangeGate(vendorId);
    expect(cleared.gating).toBe(false);
    expect(cleared.status).toBe("cleared");
  });

  it("keeps a callback_failed review gating even once the recent window has elapsed (permanent block, not window-limited)", async () => {
    const vendorId = await makeVendor({ bankAccountLast4: "5555", bankAccountChangedAt: daysAgoIso(1) });
    const { review } = await getOrCreateBankChangeReview({ vendorId, oldBankLast4: "0000", newBankLast4: "5555" });
    reviewIds.push(review.id);
    await recordCallbackOutcome(review.id, "failed");

    // Backdate the vendor's bank_account_changed_at past the recent window — the review's own
    // status must still govern, not the window.
    await sql`UPDATE vendors SET bank_account_changed_at = ${daysAgoIso(BANK_CHANGE_RECENT_WINDOW_DAYS + 10)} WHERE id = ${vendorId}`;

    const result = await detectBankChangeGate(vendorId);
    expect(result.gating).toBe(true);
    expect(result.status).toBe("callback_failed");
  });

  it("throws for an unknown vendor id", async () => {
    await expect(detectBankChangeGate(crypto.randomUUID())).rejects.toThrow(/no vendor found/);
  });
});

describe("getOrCreateBankChangeReview (idempotent creation)", () => {
  it("creates a callback_pending row on first call", async () => {
    const vendorId = await makeVendor({ bankAccountLast4: "6666", bankAccountChangedAt: daysAgoIso(1) });
    const { review, created } = await getOrCreateBankChangeReview({
      vendorId, oldBankLast4: "0000", newBankLast4: "6666", sourceInvoiceId: "inv-1",
    });
    reviewIds.push(review.id);
    expect(created).toBe(true);
    expect(review.status).toBe("callback_pending");
    expect(review.vendorId).toBe(vendorId);
    expect(review.sourceInvoiceId).toBe("inv-1");
  });

  it("is idempotent: a repeated call for the same vendor + new bank details returns the existing row, no duplicate", async () => {
    const vendorId = await makeVendor({ bankAccountLast4: "7777", bankAccountChangedAt: daysAgoIso(1) });
    const first = await getOrCreateBankChangeReview({ vendorId, oldBankLast4: "0000", newBankLast4: "7777" });
    reviewIds.push(first.review.id);

    const second = await getOrCreateBankChangeReview({ vendorId, oldBankLast4: "0000", newBankLast4: "7777" });
    expect(second.created).toBe(false);
    expect(second.review.id).toBe(first.review.id);

    const rows = await sql`SELECT count(*)::int as n FROM vendor_bank_change_reviews WHERE vendor_id = ${vendorId}`;
    expect(rows[0].n).toBe(1);
  });

  it("throws for an unknown vendor id rather than inserting an orphaned row", async () => {
    await expect(
      getOrCreateBankChangeReview({ vendorId: crypto.randomUUID(), newBankLast4: "8888" })
    ).rejects.toThrow(/no vendor found/);
  });
});

describe("logCallbackAttempt", () => {
  it("records phone used, confirmed-by, and a timestamp", async () => {
    const vendorId = await makeVendor({ bankAccountLast4: "8001", bankAccountChangedAt: daysAgoIso(1) });
    const { review } = await getOrCreateBankChangeReview({ vendorId, newBankLast4: "8001" });
    reviewIds.push(review.id);

    const updated = await logCallbackAttempt({ reviewId: review.id, phoneUsed: "+1-555-0199", confirmedBy: "Alice Maker" });
    expect(updated.callbackPhoneUsed).toBe("+1-555-0199");
    expect(updated.callbackConfirmedBy).toBe("Alice Maker");
    expect(updated.callbackAt).toBeTruthy();
    expect(updated.status).toBe("callback_pending");
  });

  it("throws if the review is not callback_pending", async () => {
    const vendorId = await makeVendor({ bankAccountLast4: "8002", bankAccountChangedAt: daysAgoIso(1) });
    const { review } = await getOrCreateBankChangeReview({ vendorId, newBankLast4: "8002" });
    reviewIds.push(review.id);
    await logCallbackAttempt({ reviewId: review.id, phoneUsed: "+1-555-0100", confirmedBy: "Alice Maker" });
    await recordCallbackOutcome(review.id, "confirmed");

    await expect(
      logCallbackAttempt({ reviewId: review.id, phoneUsed: "+1-555-0200", confirmedBy: "Alice Maker" })
    ).rejects.toThrow(/not 'callback_pending'/);
  });

  it("rejects a blank phone number or confirmed-by name", async () => {
    const vendorId = await makeVendor({ bankAccountLast4: "8003", bankAccountChangedAt: daysAgoIso(1) });
    const { review } = await getOrCreateBankChangeReview({ vendorId, newBankLast4: "8003" });
    reviewIds.push(review.id);

    await expect(logCallbackAttempt({ reviewId: review.id, phoneUsed: "   ", confirmedBy: "Alice" })).rejects.toThrow(/non-blank/);
    await expect(logCallbackAttempt({ reviewId: review.id, phoneUsed: "+1-555-0100", confirmedBy: "" })).rejects.toThrow(/non-blank/);
  });
});

describe("recordCallbackOutcome", () => {
  it("cannot record 'confirmed' without a logged callback attempt", async () => {
    const vendorId = await makeVendor({ bankAccountLast4: "9001", bankAccountChangedAt: daysAgoIso(1) });
    const { review } = await getOrCreateBankChangeReview({ vendorId, newBankLast4: "9001" });
    reviewIds.push(review.id);

    await expect(recordCallbackOutcome(review.id, "confirmed")).rejects.toThrow(/without a logged callback attempt/);
  });

  it("'failed' does not require a logged callback attempt (covers the never-attempted / abandoned case)", async () => {
    const vendorId = await makeVendor({ bankAccountLast4: "9002", bankAccountChangedAt: daysAgoIso(1) });
    const { review } = await getOrCreateBankChangeReview({ vendorId, newBankLast4: "9002" });
    reviewIds.push(review.id);

    const updated = await recordCallbackOutcome(review.id, "failed");
    expect(updated.status).toBe("callback_failed");
  });

  it("flips the vendor to trust_tier='flagged' on a failed outcome", async () => {
    const vendorId = await makeVendor({ bankAccountLast4: "9003", bankAccountChangedAt: daysAgoIso(1), trustTier: "trusted" });
    const { review } = await getOrCreateBankChangeReview({ vendorId, newBankLast4: "9003" });
    reviewIds.push(review.id);
    await logCallbackAttempt({ reviewId: review.id, phoneUsed: "+1-555-0100", confirmedBy: "Alice Maker" });

    await recordCallbackOutcome(review.id, "failed");
    expect(await vendorTrustTier(vendorId)).toBe("flagged");
  });

  it("does not flip trust_tier on a confirmed outcome (still needs second-reviewer sign-off)", async () => {
    const vendorId = await makeVendor({ bankAccountLast4: "9004", bankAccountChangedAt: daysAgoIso(1), trustTier: "trusted" });
    const { review } = await getOrCreateBankChangeReview({ vendorId, newBankLast4: "9004" });
    reviewIds.push(review.id);
    await logCallbackAttempt({ reviewId: review.id, phoneUsed: "+1-555-0100", confirmedBy: "Alice Maker" });

    await recordCallbackOutcome(review.id, "confirmed");
    expect(await vendorTrustTier(vendorId)).toBe("trusted");
  });

  it("throws if the review is not callback_pending", async () => {
    const vendorId = await makeVendor({ bankAccountLast4: "9005", bankAccountChangedAt: daysAgoIso(1) });
    const { review } = await getOrCreateBankChangeReview({ vendorId, newBankLast4: "9005" });
    reviewIds.push(review.id);
    await recordCallbackOutcome(review.id, "failed");

    await expect(recordCallbackOutcome(review.id, "failed")).rejects.toThrow(/not 'callback_pending'/);
  });
});

describe("recordSecondReviewerSignOff — maker/checker enforcement", () => {
  async function setUpConfirmedReview(bankLast4: string, callbackConfirmedBy: string) {
    const vendorId = await makeVendor({ bankAccountLast4: bankLast4, bankAccountChangedAt: daysAgoIso(1) });
    const { review } = await getOrCreateBankChangeReview({ vendorId, newBankLast4: bankLast4 });
    reviewIds.push(review.id);
    await logCallbackAttempt({ reviewId: review.id, phoneUsed: "+1-555-0100", confirmedBy: callbackConfirmedBy });
    await recordCallbackOutcome(review.id, "confirmed");
    return { vendorId, reviewId: review.id };
  }

  it("THROWS when the second reviewer is the same person who logged the callback", async () => {
    const { reviewId } = await setUpConfirmedReview("1001", "Alice Maker");
    await expect(recordSecondReviewerSignOff(reviewId, "Alice Maker")).rejects.toThrow(/maker\/checker violation/);
  });

  it("THROWS on a case/whitespace-only difference — the invariant is never silently bypassable", async () => {
    const { reviewId } = await setUpConfirmedReview("1002", "Alice Maker");
    await expect(recordSecondReviewerSignOff(reviewId, "  alice maker  ")).rejects.toThrow(/maker\/checker violation/);
  });

  it("leaves the review gating after a rejected sign-off attempt", async () => {
    const { vendorId, reviewId } = await setUpConfirmedReview("1003", "Alice Maker");
    await expect(recordSecondReviewerSignOff(reviewId, "Alice Maker")).rejects.toThrow();

    const gate = await detectBankChangeGate(vendorId);
    expect(gate.gating).toBe(true);
    expect(gate.status).toBe("callback_confirmed");
    const review = await getBankChangeReview(reviewId);
    expect(review?.secondReviewerName).toBeUndefined();
  });

  it("succeeds when the second reviewer genuinely differs from the callback logger", async () => {
    const { reviewId } = await setUpConfirmedReview("1004", "Alice Maker");
    const updated = await recordSecondReviewerSignOff(reviewId, "Bob Checker");
    expect(updated.secondReviewerName).toBe("Bob Checker");
  });

  it("throws on a second attempt to sign off the same review", async () => {
    const { reviewId } = await setUpConfirmedReview("1005", "Alice Maker");
    await recordSecondReviewerSignOff(reviewId, "Bob Checker");
    await expect(recordSecondReviewerSignOff(reviewId, "Carol Checker")).rejects.toThrow(/already has a second-reviewer sign-off/);
  });

  it("throws if the review has not reached callback_confirmed yet", async () => {
    const vendorId = await makeVendor({ bankAccountLast4: "1006", bankAccountChangedAt: daysAgoIso(1) });
    const { review } = await getOrCreateBankChangeReview({ vendorId, newBankLast4: "1006" });
    reviewIds.push(review.id);
    await expect(recordSecondReviewerSignOff(review.id, "Bob Checker")).rejects.toThrow(/not 'callback_confirmed'/);
  });
});

describe("checkAbandonmentTimeout", () => {
  it("is not abandoned immediately after creation", async () => {
    const vendorId = await makeVendor({ bankAccountLast4: "2001", bankAccountChangedAt: daysAgoIso(1) });
    const { review } = await getOrCreateBankChangeReview({ vendorId, newBankLast4: "2001" });
    reviewIds.push(review.id);

    const result = await checkAbandonmentTimeout(review.id);
    expect(result.abandoned).toBe(false);
    expect(result.shouldFlagVendor).toBe(false);
  });

  it("reports abandoned + shouldFlagVendor once the 15-minute timeout has elapsed, without mutating anything itself", async () => {
    const vendorId = await makeVendor({ bankAccountLast4: "2002", bankAccountChangedAt: daysAgoIso(1), trustTier: "trusted" });
    const { review } = await getOrCreateBankChangeReview({ vendorId, newBankLast4: "2002" });
    reviewIds.push(review.id);

    const backdated = new Date(Date.now() - CALLBACK_ABANDONMENT_TIMEOUT_MS - 60_000).toISOString();
    await sql`UPDATE vendor_bank_change_reviews SET created_at = ${backdated} WHERE id = ${review.id}`;

    const result = await checkAbandonmentTimeout(review.id);
    expect(result.abandoned).toBe(true);
    expect(result.shouldFlagVendor).toBe(true);
    expect(result.elapsedMs).toBeGreaterThan(CALLBACK_ABANDONMENT_TIMEOUT_MS);

    // Pure report — no side effect performed by the check itself.
    expect(await vendorTrustTier(vendorId)).toBe("trusted");
    const stillPending = await getBankChangeReview(review.id);
    expect(stillPending?.status).toBe("callback_pending");
  });

  it("is not 'abandoned' once the review has already moved past callback_pending", async () => {
    const vendorId = await makeVendor({ bankAccountLast4: "2003", bankAccountChangedAt: daysAgoIso(1) });
    const { review } = await getOrCreateBankChangeReview({ vendorId, newBankLast4: "2003" });
    reviewIds.push(review.id);
    const backdated = new Date(Date.now() - CALLBACK_ABANDONMENT_TIMEOUT_MS - 60_000).toISOString();
    await sql`UPDATE vendor_bank_change_reviews SET created_at = ${backdated} WHERE id = ${review.id}`;
    await recordCallbackOutcome(review.id, "failed");

    const result = await checkAbandonmentTimeout(review.id);
    expect(result.abandoned).toBe(false);
    expect(result.shouldFlagVendor).toBe(false);
  });
});

describe("full happy path: flagged -> callback_pending -> callback_confirmed -> cleared", () => {
  it("walks the whole state machine end to end", async () => {
    const vendorId = await makeVendor({ bankAccountLast4: "OLD1", bankAccountChangedAt: null, trustTier: "trusted" });

    // Simulate the bank change actually happening now.
    const newLast4 = "NEW1";
    await sql`UPDATE vendors SET bank_account_last4 = ${newLast4}, bank_account_changed_at = ${new Date().toISOString()} WHERE id = ${vendorId}`;

    const detected = await detectBankChangeGate(vendorId);
    expect(detected).toEqual({ gating: true, status: "flagged", bankAccountChangedAt: expect.any(String) });

    const { review, created } = await getOrCreateBankChangeReview({
      vendorId, oldBankLast4: "OLD1", newBankLast4: newLast4, sourceInvoiceId: "inv-happy-path",
    });
    reviewIds.push(review.id);
    expect(created).toBe(true);

    // Re-detecting after the review exists should not create a second row and should now read as callback_pending.
    const afterCreate = await detectBankChangeGate(vendorId);
    expect(afterCreate.status).toBe("callback_pending");
    const dup = await getOrCreateBankChangeReview({ vendorId, oldBankLast4: "OLD1", newBankLast4: newLast4 });
    expect(dup.created).toBe(false);
    expect(dup.review.id).toBe(review.id);

    await logCallbackAttempt({ reviewId: review.id, phoneUsed: "+1-555-0177", confirmedBy: "Alice Maker" });
    const confirmed = await recordCallbackOutcome(review.id, "confirmed");
    expect(confirmed.status).toBe("callback_confirmed");
    expect(await vendorTrustTier(vendorId)).toBe("trusted"); // not flagged mid-flow

    const signedOff = await recordSecondReviewerSignOff(review.id, "Bob Checker");
    expect(signedOff.secondReviewerName).toBe("Bob Checker");

    const cleared = await detectBankChangeGate(vendorId);
    expect(cleared.gating).toBe(false);
    expect(cleared.status).toBe("cleared");
    expect(await vendorTrustTier(vendorId)).toBe("trusted");
  });

  it("walks the failure branch: flagged -> callback_pending -> callback_failed, vendor flagged, permanently blocked", async () => {
    const vendorId = await makeVendor({ bankAccountLast4: "BAD1", bankAccountChangedAt: daysAgoIso(1), trustTier: "trusted" });
    const { review } = await getOrCreateBankChangeReview({ vendorId, oldBankLast4: "OLD9", newBankLast4: "BAD1" });
    reviewIds.push(review.id);

    await logCallbackAttempt({ reviewId: review.id, phoneUsed: "+1-555-0111", confirmedBy: "Alice Maker" });
    const failed = await recordCallbackOutcome(review.id, "failed");
    expect(failed.status).toBe("callback_failed");
    expect(await vendorTrustTier(vendorId)).toBe("flagged");

    const gate = await detectBankChangeGate(vendorId);
    expect(gate.gating).toBe(true);
    expect(gate.status).toBe("callback_failed");
  });
});
