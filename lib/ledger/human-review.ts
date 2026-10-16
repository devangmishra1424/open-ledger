import type { TransactionSql } from "postgres";
import { getSql } from "@/db/client";
import { writeDecision, writeDecisionInTx, getDecisionsForInvoice } from "@/lib/ledger/decisions";
import { postBillApprovalInTx } from "@/lib/ledger/journal";
import { detectBankChangeGate } from "@/lib/ledger/bank-change-review";
import { settleApprovedBill, settlementNote, type PaymentResult } from "@/lib/payments/payments";
import { checkHumanAction } from "@/lib/bill-workflow";
import { reconsider, isEscalateSeniorResult } from "@/lib/pipeline/reconsider";
import { HttpError } from "@/lib/http";
import type { BillStatus, Claim, Decision } from "@/lib/types";

/**
 * Human actions on an invoice — approve, reject, contest — as first-class entries in the SAME
 * hash chain as the machine decisions. A person overriding the system is exactly the event an
 * auditor most wants tamper-evident, so each action writes a `human_review` decision (who, what,
 * why) chained to everything before it, plus a row in `reviews` pointing at that decision.
 *
 * Each action is validated against lib/bill-workflow.ts (the one rulebook of what is allowed in
 * which state), and the state change, the decision and the review row commit in ONE transaction:
 * there is no moment where the ledger says "posted" but the chain has no record of who approved it.
 * Repeating an action that already happened is a harmless no-op (double-clicks, retries).
 */

/** A refused or impossible action; an HttpError so the route layer answers with its status (404 / 409 / 422) and message. */
export class HumanActionError extends HttpError {
  constructor(status: 404 | 409 | 422, message: string) {
    super(status, message);
    this.name = "HumanActionError";
  }
}

export type HumanChoice = "approve" | "reject" | "contest";

const ACTION_TAKEN: Record<HumanChoice, string> = {
  approve: "human_approved",
  reject: "human_rejected",
  contest: "human_contested",
};

const MIN_REASON_LENGTH = 10;

interface BillRow { id: string; vendorId: string; status: BillStatus; currency: string }

async function loadBill(billId: string): Promise<BillRow> {
  const rows = await getSql()`SELECT id, vendor_id, status, currency FROM vendor_bills WHERE id = ${billId}`;
  if (rows.length === 0) throw new HumanActionError(404, `no invoice found with id '${billId}'`);
  return { id: rows[0].id, vendorId: rows[0].vendor_id, status: rows[0].status, currency: rows[0].currency };
}

/** Writes the human_review decision + its reviews row, inside the caller's transaction. */
async function recordHumanDecision(
  tx: TransactionSql<{}>,
  p: { billId: string; reviewer: string; choice: HumanChoice; note?: string; extraClaims?: Claim[] },
): Promise<Decision> {
  const prior = await tx`SELECT id, node_id, reason_code, superseded_by_id FROM decisions WHERE invoice_id = ${p.billId} ORDER BY seq ASC`;
  const live = prior.filter((r: any) => !r.superseded_by_id);
  const parent = live[live.length - 1];
  const policy = [...live].reverse().find((r: any) => r.node_id === "policy");
  const priorHumanCount = prior.filter((r: any) => r.node_id === "human_review").length;

  const claims: Claim[] = [];
  if (p.note) claims.push({ text: p.note, tag: "grounded" });
  if (p.extraClaims) claims.push(...p.extraClaims);

  const now = new Date().toISOString();
  const decision = await writeDecisionInTx(tx, {
    invoiceId: p.billId, nodeId: "human_review", agentId: `human:${p.reviewer}`,
    parentDecisionId: parent?.id, startedAt: now, endedAt: now,
    actionTaken: ACTION_TAKEN[p.choice], reasonCode: policy?.reason_code ?? undefined,
    claims: claims.length > 0 ? claims : undefined,
    triggeredByActor: p.reviewer, triggeredByQuestion: p.choice === "contest" ? p.note : undefined,
    // Keyed on how many human actions the invoice already has: a double-submit of the same click
    // collapses into one decision, while a genuinely later action (reject, contest, reject again)
    // gets its own.
    idempotencyKey: `human:${p.billId}:${p.choice}:${priorHumanCount}`,
  });
  await tx`
    INSERT INTO reviews (id, invoice_id, reviewer_name, action, reason_code, note, decision_id)
    VALUES (${decision.id}, ${p.billId}, ${p.reviewer}, ${p.choice}, ${policy?.reason_code ?? null}, ${p.note ?? null}, ${decision.id})
    ON CONFLICT (id) DO NOTHING`;
  return decision;
}

export interface ActionOutcome {
  /** true when the invoice was already in the state this action produces; nothing was written. */
  alreadyDone: boolean;
  decision?: Decision;
  payment?: PaymentResult;
  paymentError?: string;
  /** Why approving moved no money: a credit memo is never paid, and credits can cover a whole invoice. */
  noPayment?: "credit_memo" | "covered_by_credit";
}

export async function approveInvoice(p: { billId: string; reviewer: string; note?: string }): Promise<ActionOutcome> {
  const bill = await loadBill(p.billId);
  const gate = await detectBankChangeGate(bill.vendorId);
  const check = checkHumanAction(bill.status, "approve", { bankChangeHold: gate.gating });
  if (!check.allowed) throw new HumanActionError(409, check.reason);
  if (check.alreadyDone) return { alreadyDone: true };

  let decision: Decision | null;
  try {
    decision = await getSql().begin(async (tx) => {
      const posted = await postBillApprovalInTx(tx, p.billId); // throws if the invoice cannot be posted (no GL account, closed period, void...)
      // Someone else (a double-click, the pipeline) posted it between our check and now: it is
      // already approved, and this call did not do it, so it must not claim to have.
      if (posted.alreadyPosted) return null;
      return recordHumanDecision(tx, { billId: p.billId, reviewer: p.reviewer, choice: "approve", note: p.note });
    });
  } catch (e) {
    console.error(`approveInvoice ${p.billId} could not post:`, e);
    throw new HumanActionError(422, `could not post to the ledger: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!decision) return { alreadyDone: true };

  // The invoice is now approved and POSTED. Payment is a separate step with its own failure
  // mode: if it fails the ledger entry is still correct and the invoice stays posted-but-unpaid,
  // with the failure on the record. A credit memo is never paid (settleApprovedBill pays nothing).
  try {
    const settlement = await settleApprovedBill(p.billId);
    // When approving did not simply pay the total, the trail says what happened instead.
    const note = settlementNote(settlement, bill.currency);
    if (note) {
      const now = new Date().toISOString();
      await writeDecision({
        invoiceId: p.billId, nodeId: "audit", agentId: "deterministic-policy-engine",
        parentDecisionId: decision.id, startedAt: now, endedAt: now,
        actionTaken: settlement.kind === "paid" ? "paid_less_credit" : "no_payment",
        claims: [{ text: note, tag: "grounded" }],
        idempotencyKey: `human:${p.billId}:settlement:${decision.id}`,
      });
    }
    if (settlement.kind === "paid") return { alreadyDone: false, decision, payment: settlement.payment };
    return { alreadyDone: false, decision, noPayment: settlement.kind };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const now = new Date().toISOString();
    await writeDecision({
      invoiceId: p.billId, nodeId: "audit", agentId: "deterministic-policy-engine",
      parentDecisionId: decision.id, startedAt: now, endedAt: now,
      actionTaken: "payment_failed", reasonCode: "R99_AGENT_ERROR",
      claims: [{ text: `Approved by ${p.reviewer} and posted to the ledger, but payment did not go out: ${message}`, tag: "grounded" }],
      idempotencyKey: `human:${p.billId}:payment_failed:${decision.id}`,
    });
    return { alreadyDone: false, decision, paymentError: message };
  }
}

export async function rejectInvoice(p: { billId: string; reviewer: string; note?: string }): Promise<ActionOutcome> {
  const bill = await loadBill(p.billId);
  const check = checkHumanAction(bill.status, "reject");
  if (!check.allowed) throw new HumanActionError(409, check.reason);
  if (check.alreadyDone) return { alreadyDone: true };

  const decision = await getSql().begin(async (tx) => {
    const updated = await tx`UPDATE vendor_bills SET status = 'void' WHERE id = ${p.billId} AND status IN ('exception', 'matched') RETURNING id`;
    if (updated.length === 0) {
      // Lost a race. If the other writer rejected it too (a double-click), that is simply done.
      const now = await tx`SELECT status FROM vendor_bills WHERE id = ${p.billId}`;
      if (now[0]?.status === "void") return null;
      throw new HumanActionError(409, "this invoice changed while you were rejecting it — reload and look again");
    }
    return recordHumanDecision(tx, { billId: p.billId, reviewer: p.reviewer, choice: "reject", note: p.note });
  });
  if (!decision) return { alreadyDone: true };
  return { alreadyDone: false, decision };
}

export interface ContestOutcome extends ActionOutcome {
  /** What the AI re-review did. `possible: false` means the block came from a deterministic rule that has nothing to reconsider. */
  reconsideration:
    | { possible: false; reason: string }
    | { possible: true; escalatedToSenior: true; message: string }
    | { possible: true; escalatedToSenior: false; cascaded: boolean; newDecisionId: string }
    | { possible: true; failed: true; error: string };
}

/**
 * Contest: record the reviewer's challenge on the chain first (so the question is on the record
 * even if the AI call fails), then ask the Investigator/Verifier to re-examine with the
 * reviewer's reason as the question (lib/pipeline/reconsider.ts).
 */
export async function contestInvoice(p: { billId: string; reviewer: string; reason: string }): Promise<ContestOutcome> {
  if (p.reason.trim().length < MIN_REASON_LENGTH) {
    throw new HumanActionError(422, `give a reason of at least ${MIN_REASON_LENGTH} characters — the AI re-review answers exactly what you ask`);
  }
  const bill = await loadBill(p.billId);
  const check = checkHumanAction(bill.status, "contest");
  if (!check.allowed) throw new HumanActionError(409, check.reason);

  const decisions = await getDecisionsForInvoice(p.billId);
  const reconsiderable = decisions.filter((d) => !d.supersededById && (d.nodeId === "investigate" || d.nodeId === "verify"));
  const target = reconsiderable[reconsiderable.length - 1];

  const decision = await getSql().begin((tx) => recordHumanDecision(tx, { billId: p.billId, reviewer: p.reviewer, choice: "contest", note: p.reason }));

  if (!target) {
    return {
      alreadyDone: false, decision,
      reconsideration: { possible: false, reason: "this invoice was stopped by a deterministic rule before any AI review ran, so there is no AI judgment to reconsider — approve or reject it instead" },
    };
  }

  try {
    const result = await reconsider({ originalDecisionId: target.id, question: p.reason, actor: p.reviewer });
    if (isEscalateSeniorResult(result)) {
      return { alreadyDone: false, decision, reconsideration: { possible: true, escalatedToSenior: true, message: result.error } };
    }
    return { alreadyDone: false, decision, reconsideration: { possible: true, escalatedToSenior: false, cascaded: result.cascaded, newDecisionId: result.newDecision.id } };
  } catch (e) {
    console.error(`contestInvoice ${p.billId}: reconsideration failed:`, e);
    return { alreadyDone: false, decision, reconsideration: { possible: true, failed: true, error: e instanceof Error ? e.message : String(e) } };
  }
}
