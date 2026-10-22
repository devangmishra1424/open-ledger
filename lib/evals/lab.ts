import { randomUUID } from "node:crypto";
import { activeSchema, getSql } from "@/db/client";
import { HttpError } from "@/lib/http";
import { createBill, type CreatedBill, type NewBillInput } from "@/lib/bills";
import { createPurchaseOrder, recordReceipt, type CreatedPo, type NewPoInput, type NewReceipt } from "@/lib/purchase-orders";
import { postBillApproval } from "@/lib/ledger/journal";
import { spreadTax, statedTaxRate } from "@/lib/tax-lines";
import type { Action, CombinedDecision, ExceptionCode } from "@/lib/matching/decision-matrix";
import { gateReasonCode } from "@/lib/matching/pre-match-validation";
import {
  evaluatePolicy, runAuditStage, runExtractStage, runMatchStageDecision, runPipeline, runPolicyStage, runValidateStage,
} from "@/lib/pipeline/orchestrator";
import { breachedInvoiceIds, checkMoneyRules, moneyRulesSection } from "./money-rules";
import {
  DEFAULT_TARGETS, REPORT_VERSION, evaluateTargets, percentile, summaryOf, verdictOf,
  type AiValue, type CaseResult, type EvalReport, type FailureItem, type JourneyRow, type OperationRow, type Outcome, type Targets,
} from "./report";

/**
 * The lab run: hand-labelled cases (eval/decisions/cases.ts) through the real pipeline, in a schema of their own.
 *
 * Two modes. "rules" runs every deterministic stage (entry, checks, matching, decision, posting and paying) with the
 * AI review left out: it needs no AI key, is the same on every run, and is what CI gates on. "rules+ai" runs the full
 * pipeline including the AI review, so the report can show what the AI changed (an ablation): which outcomes it moved,
 * and whether each move was right.
 *
 * Concurrency: cases run one after another, and each case's names and numbers carry a tag unique to the run and case,
 * so a run never collides with an earlier run in the same schema or with itself. Nothing is shared between cases.
 */

export type Stage = "intake" | "validate" | "match" | "decide";

export interface LabCase {
  id: string;
  title: string;
  journey: JourneyKey;
  /** The section of docs/ap-three-way-match-spec.md (or the owner's Settings) the expected answer comes from. */
  rule: string;
  /** Why that is the right answer, in a sentence. */
  why: string;
  /** An input built to fool the checks. */
  trick?: boolean;
  expect: {
    outcome: Outcome;
    /** The reason the record must give (the dominant reason code). Omitted when the policy does not pin one. */
    reason?: string;
    /** The exact action, where the policy is unambiguous about the level. */
    action?: Action;
    /** The step that must stop it; null for an invoice that should go straight through. */
    stage: Stage | null;
  };
  /** Enters the case's documents and returns the invoice to decide. Throwing an HttpError means the entry was refused. */
  build(ctx: CaseContext): Promise<string>;
}

export type JourneyKey = "ordered" | "partial" | "tax_currency" | "no_po" | "limits" | "credit_bank" | "duplicates";

export const JOURNEYS: Record<JourneyKey, string> = {
  ordered: "Ordered and delivered",
  partial: "Delivered in parts",
  tax_currency: "Tax and currency",
  no_po: "No usable order",
  limits: "Limits",
  credit_bank: "Credits and bank accounts",
  duplicates: "Duplicates",
};

export interface CaseContext {
  /** Unique to the run and the case. Vendor names and document numbers are built from it. */
  tag: string;
  sql: ReturnType<typeof getSql>;
  vendor(label: string): string;
  number(suffix: string): string;
  /** An ISO date `offset` days from today. */
  day(offset: number): string;
  /** A purchase order (ordered 20 days ago; a receipt given here is dated 10 days ago unless it says otherwise). */
  po(input: Partial<NewPoInput> & { lines: NewPoInput["lines"] }): Promise<CreatedPo>;
  receive(poId: string, receipt: NewReceipt): Promise<void>;
  /** An invoice (dated 5 days ago, numbered from the tag, totals checked) as the review screen saves it. */
  bill(input: Partial<NewBillInput> & { lines: NewBillInput["lines"] }): Promise<CreatedBill>;
  /** Decides an earlier invoice with the rules and requires it to come out approved: setup, not the thing under test. */
  approved(bill: CreatedBill): Promise<void>;
  /** Posts an earlier invoice to the ledger without paying it (approved, payment not yet run). */
  postedUnpaid(billId: string): Promise<void>;
  trust(vendorId: string): Promise<void>;
  /** The tax fields for an invoice printing `label` (e.g. "GST 18%") and charging `charged` on lines worth `items`. */
  tax(label: string, charged: number, items: number[]): Pick<NewBillInput, "tax" | "statedTax">;
  /** Time spent deciding or posting the case's earlier invoices: setup, left out of the entry step's timing. */
  setupMs: number;
}

/** Only a schema made for evaluation may be filled with lab invoices: never the live demo, never `public`. */
const LAB_SCHEMA = /_(eval|test)$/;

export function assertLabSchema(): string {
  const schema = activeSchema();
  if (!schema || !LAB_SCHEMA.test(schema)) {
    throw new Error(`the lab run writes invoices and payments, so it only runs in a schema ending in _eval or _test (DB_SCHEMA is '${schema ?? "(unset: the live schema)"}')`);
  }
  return schema;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

function contextFor(tag: string): CaseContext {
  const sql = getSql();
  let pos = 0;
  const day = (offset: number) => iso(new Date(Date.now() + offset * 864e5));
  const ctx: CaseContext = {
    tag, sql, day, setupMs: 0,
    vendor: (label) => `${tag} ${label}`,
    number: (suffix) => `${tag}-${suffix}`,
    po: (input) => createPurchaseOrder({
      vendorName: input.vendorId ? undefined : ctx.vendor("Supplier"),
      poNumber: `${tag}-PO${++pos}`,
      orderDate: day(-20),
      ...input,
      receipt: input.receipt ? { receiptDate: day(-10), ...input.receipt } : null,
    }),
    receive: async (poId, receipt) => { await recordReceipt(poId, { receiptDate: day(-10), ...receipt }); },
    bill: (input) => createBill({
      vendorName: input.vendorId ? undefined : ctx.vendor("Supplier"),
      invoiceNumber: `${tag}-INV`,
      invoiceDate: day(-5),
      strictTotals: true,
      ...input,
    }),
    approved: async (bill) => {
      const t0 = performance.now();
      await decideByRules(bill.billId);
      ctx.setupMs += performance.now() - t0;
      const [row] = await sql`SELECT status FROM vendor_bills WHERE id = ${bill.billId}`;
      if (row?.status !== "posted" && row?.status !== "paid") {
        throw new Error(`setup: earlier invoice ${bill.invoiceNumber} was meant to be approved but came out '${row?.status}'`);
      }
    },
    postedUnpaid: async (billId) => {
      const t0 = performance.now();
      await postBillApproval(billId);
      ctx.setupMs += performance.now() - t0;
    },
    trust: async (vendorId) => { await sql`UPDATE vendors SET trust_tier = 'trusted' WHERE id = ${vendorId}`; },
    tax: (label, charged, items) => {
      const stated = statedTaxRate([{ label, amount: charged }]);
      if (!stated) throw new Error(`setup: '${label}' does not print a rate`);
      const perLine = spreadTax({ charged, items, charges: [], discount: 0, rate: stated.rate });
      if (!perLine) throw new Error(`setup: tax ${charged} could not be spread over ${items.join(", ")}`);
      return { tax: charged, statedTax: { ...stated, perLine } };
    },
  };
  return ctx;
}

type StageTimes = Map<string, number[]>;

async function timed<T>(times: StageTimes, stage: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    times.set(stage, [...(times.get(stage) ?? []), performance.now() - t0]);
  }
}

const cascaded = (action: Action, code: ExceptionCode | null): CombinedDecision => ({ overallAction: action, dominantException: code, cascaded: true, deferredExceptions: [] });

/**
 * Every deterministic stage, in the pipeline's own order, with the AI review left out: the outcome the rules alone
 * reach. Mirrors orchestrator.runFromValidate's branches (a failed check or a stopping finding goes straight to the
 * decision); with no Investigator, the confidence guardrail does not apply and the amount limit still does.
 */
async function decideByRules(billId: string, times: StageTimes = new Map()): Promise<void> {
  const extract = await timed(times, "extract", () => runExtractStage(billId));
  if (extract.actionTaken === "error") {
    const policy = await timed(times, "decide", () => runPolicyStage({ vendorBillId: billId, combined: cascaded("block", null), reasonCodeOverride: "R99_AGENT_ERROR", parentDecisionId: extract.id }));
    await timed(times, "post_pay", () => runAuditStage(billId, policy));
    return;
  }
  const { decision: validate, result } = await timed(times, "validate", () => runValidateStage(billId, extract.id));
  if (!result.passed) {
    const blocking = result.blockingFinding!;
    const reasonCodeOverride = blocking.exceptionCode ? undefined : gateReasonCode(blocking);
    const policy = await timed(times, "decide", () => runPolicyStage({ vendorBillId: billId, combined: cascaded(blocking.action as Action, blocking.exceptionCode ?? null), reasonCodeOverride, parentDecisionId: validate.id }));
    await timed(times, "post_pay", () => runAuditStage(billId, policy));
    return;
  }
  const { decision: match, matchResult } = await timed(times, "match", () => runMatchStageDecision(billId, validate.id));
  const policy = await timed(times, "decide", () => runPolicyStage({ vendorBillId: billId, combined: matchResult.combined, parentDecisionId: match.id }));
  await timed(times, "post_pay", () => runAuditStage(billId, policy));
}

interface Got {
  outcome: Outcome;
  reason: string | null;
  action: string | null;
  found: string[];
  caughtBy: Stage | null;
  /** What the rules alone said (from the match step and the amount limit): the baseline the AI review is compared with. */
  rulesOutcome: Outcome | null;
}

const outcomeOfStatus = (status: string): Outcome => (status === "void" ? "rejected" : status === "posted" || status === "paid" ? "approved" : "held");
const outcomeOfAction = (action: string): Outcome => (action === "auto_approve" ? "approved" : action === "auto_reject" ? "rejected" : "held");

/** What the record says happened to an invoice: read back from the database, not from the run's return values. */
async function readOutcome(billId: string): Promise<Got> {
  const sql = getSql();
  const [bill] = await sql`SELECT status, total_amount, currency FROM vendor_bills WHERE id = ${billId}`;
  const decisions = await sql`
    SELECT node_id, action_taken, reason_code, claims FROM decisions
    WHERE invoice_id = ${billId} AND superseded_by_id IS NULL ORDER BY seq`;
  const last = (node: string) => [...decisions].reverse().find((d) => d.node_id === node);
  const validate = last("validate");
  const match = last("match");
  const policy = last("policy");
  const claims: Array<{ text: string }> = match?.claims ? JSON.parse(match.claims) : [];
  const found = [...new Set(claims.map((c) => /^(EXC-[A-Z_]+): /.exec(c.text)?.[1]).filter((c): c is string => Boolean(c)))];
  if (validate && validate.action_taken !== "pass" && validate.reason_code) found.unshift(validate.reason_code);

  let caughtBy: Stage | null = null;
  if (validate && validate.action_taken !== "pass") caughtBy = "validate";
  else if (match && match.action_taken !== "auto_approve") caughtBy = "match";
  else if (policy && policy.action_taken !== "auto_approve") caughtBy = "decide";

  let rulesOutcome: Outcome | null = null;
  if (validate && validate.action_taken !== "pass") rulesOutcome = outcomeOfAction(validate.action_taken);
  else if (match) {
    const combined: CombinedDecision = { overallAction: match.action_taken as Action, dominantException: match.reason_code === "CLEAN_MATCH" ? null : match.reason_code, cascaded: false, deferredExceptions: [] };
    rulesOutcome = outcomeOfAction((await evaluatePolicy(billId, combined, undefined, undefined)).action);
  }
  return {
    outcome: outcomeOfStatus(bill.status),
    reason: policy?.reason_code ?? null,
    action: policy?.action_taken ?? null,
    found, caughtBy, rulesOutcome,
  };
}

export interface LabOptions {
  cases: LabCase[];
  ai: boolean;
  targets?: Targets;
  codeVersion?: string | null;
  log?: (line: string) => void;
}

/** Runs every case and builds the report. Refuses to run outside an evaluation schema. */
export async function runLab(opts: LabOptions): Promise<EvalReport> {
  assertLabSchema();
  const ids = new Set<string>();
  for (const c of opts.cases) {
    if (ids.has(c.id)) throw new Error(`two lab cases share the id '${c.id}'`);
    ids.add(c.id);
  }
  const log = opts.log ?? (() => {});
  const runTag = `EV${randomUUID().slice(0, 6)}`;
  const times: StageTimes = new Map();
  const results: Array<CaseResult & { rulesOutcome: Outcome | null; machineMs: number }> = [];

  for (const c of opts.cases) {
    const tag = `${runTag}-${c.id}`;
    const ctx = contextFor(tag);
    const t0 = performance.now();
    let billId: string | null = null;
    let got: Got | null = null;
    let error: string | undefined;
    let machineMs = 0;
    const b0 = performance.now();
    try {
      billId = await c.build(ctx);
    } catch (e) {
      if (e instanceof HttpError) {
        // Refused at entry. The duplicate refusal is the entry step's EXC-DUPLICATE (lib/bills.ts, 409).
        const reason = e.status === 409 && /already received/.test(e.message) ? "EXC-DUPLICATE" : null;
        got = { outcome: "refused", reason, action: null, found: reason ? [reason] : [], caughtBy: "intake", rulesOutcome: "refused" };
      } else {
        error = `setup failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    times.set("intake", [...(times.get("intake") ?? []), performance.now() - b0 - ctx.setupMs]);
    if (billId) {
      const m0 = performance.now();
      try {
        if (opts.ai) await timed(times, "pipeline", () => runPipeline(billId!));
        else await decideByRules(billId, times);
      } catch (e) {
        // runPipeline records a crash on the invoice before re-throwing; the rules path does not, so the report says so.
        error = `pipeline crashed: ${e instanceof Error ? e.message : String(e)}`;
      }
      machineMs = performance.now() - m0;
      got = await readOutcome(billId);
    }

    const g = got ?? { outcome: "held" as Outcome, reason: null, action: null, found: [], caughtBy: null, rulesOutcome: null };
    const outcomeOk = !error && g.outcome === c.expect.outcome;
    const reasonOk = !error && (c.expect.reason === undefined || g.reason === c.expect.reason || (g.outcome === "refused" && g.found.includes(c.expect.reason)));
    const actionOk = c.expect.action === undefined ? null : !error && g.action === c.expect.action;
    results.push({
      id: c.id, title: c.title, journey: c.journey, rule: c.rule, trick: Boolean(c.trick),
      expected: { outcome: c.expect.outcome, reason: c.expect.reason, action: c.expect.action },
      got: { outcome: g.outcome, reason: g.reason, action: g.action, found: g.found, caughtBy: g.caughtBy },
      outcomeOk, reasonOk, actionOk, ms: Math.round(performance.now() - t0), invoiceId: billId, error,
      rulesOutcome: g.rulesOutcome, machineMs,
    });
    log(`${outcomeOk && reasonOk ? "ok  " : "FAIL"} ${c.id.padEnd(30)} expected ${c.expect.outcome}${c.expect.reason ? ` (${c.expect.reason})` : ""}, got ${error ? `ERROR: ${error}` : `${g.outcome}${g.reason ? ` (${g.reason})` : ""}`}`);
  }

  return buildLabReport(opts, results, times);
}

async function buildLabReport(
  opts: LabOptions,
  results: Array<CaseResult & { rulesOutcome: Outcome | null; machineMs: number }>,
  times: StageTimes,
): Promise<EvalReport> {
  const sql = getSql();
  const byId = new Map(opts.cases.map((c) => [c.id, c]));
  const billIds = results.map((r) => r.invoiceId).filter((id): id is string => Boolean(id));
  const ruleResults = await checkMoneyRules(billIds);
  const breached = breachedInvoiceIds(ruleResults);

  const wronglyPaid = results.filter((r) => r.got.outcome === "approved" && r.expected.outcome !== "approved");
  const wronglyHeld = results.filter((r) => !r.error && r.expected.outcome === "approved" && r.got.outcome !== "approved");
  // Silent: a wrong approval the record gave no warning about (no finding at all), a crash nothing recorded, or a
  // money rule broken. A wrong outcome WITH a finding on the record is wrong, but a person reading the trail would see it.
  const silent = new Set<string>([
    ...wronglyPaid.filter((r) => r.got.found.length === 0).map((r) => r.id),
    ...results.filter((r) => r.error?.startsWith("pipeline crashed") && !opts.ai).map((r) => r.id),
    ...results.filter((r) => r.invoiceId && breached.has(r.invoiceId)).map((r) => r.id),
  ]);

  const right = results.filter((r) => r.outcomeOk && r.reasonOk && !r.error);
  const p95Machine = percentile(results.filter((r) => r.invoiceId).map((r) => r.machineMs / 1000), 0.95);

  const money = {
    checked: billIds.length,
    wronglyPaid: wronglyPaid.length,
    wronglyHeld: wronglyHeld.length,
    silentErrors: silent.size,
    rules: moneyRulesSection(ruleResults),
  };
  const targets = evaluateTargets({ kind: "lab", money, cases: { judged: results.length, right: right.length }, p95MachineSeconds: p95Machine }, opts.targets ?? DEFAULT_TARGETS);
  const verdict = verdictOf(targets);

  // --- per operation: did each step do what the policy expects of it? ---
  const stageOf = (r: CaseResult) => byId.get(r.id)!.expect.stage;
  const reached = results.filter((r) => !r.error && r.got.outcome !== "refused");
  const op = (key: string, label: string, does: string, judgedRows: CaseResult[], isRight: (r: CaseResult) => boolean, notes: string[] = []): OperationRow => {
    const ms = times.get(key) ?? [];
    return {
      key, label, does, runs: ms.length || judgedRows.length, judged: judgedRows.length, correct: judgedRows.filter(isRight).length,
      p50Ms: round(percentile(ms, 0.5)), p95Ms: round(percentile(ms, 0.95)), notes,
    };
  };
  const operations: OperationRow[] = [
    op("intake", "Entering documents", "Checks what is typed or read before an invoice exists: totals add up, no repeated number, no negative lines.",
      results.filter((r) => !r.error), (r) => (stageOf(r) === "intake") === (r.got.outcome === "refused")),
    op("validate", "Checks before matching", "Readable, not a duplicate, supported currency, sensible date, vendor not flagged.",
      reached, (r) => (stageOf(r) === "validate") === (r.got.caughtBy === "validate") && (stageOf(r) !== "validate" || r.reasonOk)),
    op("match", "Matching order, delivery and invoice", "Pairs lines and compares price, quantity, tax, units, currency, limits, credits and bank details.",
      reached.filter((r) => r.got.caughtBy !== "validate" && stageOf(r) !== "validate"),
      (r) => (stageOf(r) === "match" ? r.got.found.includes(byId.get(r.id)!.expect.reason ?? "") || byId.get(r.id)!.expect.reason === undefined : r.got.found.length === 0 || r.got.outcome === r.expected.outcome)),
    op("decide", "Deciding", "Turns the findings into one outcome (most restrictive wins) and applies the owner's limits.",
      reached, (r) => r.outcomeOk && r.reasonOk && r.actionOk !== false,
      results.some((r) => r.actionOk === false) ? [`${results.filter((r) => r.actionOk === false).length} case(s) reached the right outcome at a different level (e.g. L1 instead of Block).`] : []),
    op("post_pay", "Posting and paying", "Approved invoices go to the ledger and are paid (less any credit); nothing else moves money.",
      reached.filter((r) => r.invoiceId), (r) => !breached.has(r.invoiceId!)),
  ];
  if (opts.ai) {
    const aiMs = await stageMsFromDecisions(billIds, ["investigate", "verify"]);
    operations.splice(3, 0, {
      key: "ai_review", label: "AI review", does: "Reads the evidence, recommends an outcome (it can only make it stricter) and explains it.",
      runs: aiMs.investigate.length, judged: 0, correct: null,
      p50Ms: round(percentile(aiMs.investigate, 0.5)), p95Ms: round(percentile(aiMs.investigate, 0.95)),
      notes: ["Not scored on its own: its effect on outcomes is under 'What the AI added'."],
    });
  }

  // --- per journey ---
  const journeys: JourneyRow[] = (Object.keys(JOURNEYS) as JourneyKey[]).map((key) => {
    const rows = results.filter((r) => r.journey === key);
    const entered = rows.filter((r) => r.got.outcome !== "refused" && !r.error);
    const passedChecks = entered.filter((r) => r.got.caughtBy !== "validate");
    const matchedClean = passedChecks.filter((r) => r.got.caughtBy !== "match");
    return {
      key, label: JOURNEYS[key], entered: rows.length,
      steps: [
        { label: "Entered", count: entered.length },
        { label: "Passed the checks", count: passedChecks.length },
        { label: "Matched cleanly", count: matchedClean.length },
        { label: "Approved without a person", count: entered.filter((r) => r.got.outcome === "approved").length },
      ],
      ended: {
        approved: rows.filter((r) => r.got.outcome === "approved").length,
        held: rows.filter((r) => r.got.outcome === "held" && !r.error).length,
        rejected: rows.filter((r) => r.got.outcome === "rejected").length,
        refused: rows.filter((r) => r.got.outcome === "refused").length,
        inProgress: rows.filter((r) => r.error).length,
      },
      correct: rows.filter((r) => r.outcomeOk && r.reasonOk && !r.error).length,
    };
  }).filter((j) => j.entered > 0);

  // --- logistics ---
  const aiCalls = billIds.length === 0 ? 0 : (await sql`SELECT COUNT(*)::int AS n FROM decisions WHERE invoice_id IN ${sql(billIds)} AND model IS NOT NULL`)[0].n;
  const stageMs = [...times.entries()].map(([stage, ms]) => ({ stage, runs: ms.length, p50: round(percentile(ms, 0.5)), p95: round(percentile(ms, 0.95)) }));
  const machine = results.filter((r) => r.invoiceId).map((r) => r.machineMs / 1000);

  // --- AI value (ablation) ---
  const ai: AiValue = {
    changedOutcome: null, changedRight: null, changedWrong: null,
    aiHolds: 0, aiHoldsPersonRejected: 0, aiHoldsPersonApproved: 0, verifierDisagreed: 0,
    uncheckedFigureNotes: 0, aiExplanations: 0, challengesAnswered: 0, challengesUnanswered: 0,
    notes: opts.ai ? [] : ["Rules-only run: the AI review was not run. Run with --ai to measure what it changes."],
  };
  if (opts.ai) {
    const changed = results.filter((r) => r.rulesOutcome && r.got.outcome !== r.rulesOutcome && !r.error);
    ai.changedOutcome = changed.length;
    ai.changedRight = changed.filter((r) => r.got.outcome === r.expected.outcome).length;
    ai.changedWrong = changed.filter((r) => r.got.outcome !== r.expected.outcome).length;
    Object.assign(ai, await aiHonesty(billIds));
    if (results.some((r) => r.got.reason === "R99_AGENT_ERROR")) {
      ai.notes.push("Some AI calls failed (R99_AGENT_ERROR): those invoices were held for a person, as designed. Check the AI quota before reading the AI numbers.");
    }
  }

  const failures: FailureItem[] = results.filter((r) => !(r.outcomeOk && r.reasonOk) || r.error || silent.has(r.id)).map((r) => ({
    id: r.id, title: r.title, invoiceId: r.invoiceId ?? undefined,
    kind: r.error ? "crash" : r.got.outcome === "approved" && r.expected.outcome !== "approved" ? "wrongly_paid"
      : r.expected.outcome === "approved" && r.got.outcome !== "approved" ? "wrongly_held"
      : !r.outcomeOk ? "wrong_reason" : !r.reasonOk ? "wrong_reason" : "money_rule",
    expected: `${r.expected.outcome}${r.expected.reason ? ` (${r.expected.reason})` : ""} — ${r.rule}`,
    got: r.error ?? `${r.got.outcome}${r.got.reason ? ` (${r.got.reason})` : ""}${r.got.found.length ? `; found ${r.got.found.join(", ")}` : ""}`,
    operation: r.got.caughtBy ?? "decide",
  }));

  const caveats = [
    "Lab cases are labelled from the written policy (docs/ap-three-way-match-spec.md) and the owner's Settings; each names its section. They test decisions, not document reading (that is eval/documents).",
    `${opts.cases.length} cases, ${opts.cases.filter((c) => c.trick).length} of them built to fool the checks. A pass means these cases are decided as the policy says, not that every invoice will be.`,
    "Timings come from one run on one machine against a remote database; read them as a trend between runs, not as a promise.",
  ];
  if (!opts.ai) caveats.push("The AI review was left out (rules-only). Its effect is measured only with --ai, which spends AI quota.");

  return {
    version: REPORT_VERSION, kind: "lab", generatedAt: new Date().toISOString(), mode: opts.ai ? "rules+ai" : "rules",
    period: null, codeVersion: opts.codeVersion ?? null,
    verdict, summary: summaryOf(verdict, targets, results.length, "lab"),
    targets, money, operations, journeys,
    logistics: {
      invoices: billIds.length,
      machineSeconds: { p50: round1(percentile(machine, 0.5)), p95: round1(p95Machine), max: round1(machine.length ? Math.max(...machine) : null) },
      personWaitHours: { p50: null, p95: null, decided: 0, stillWaiting: results.filter((r) => r.got.outcome === "held").length },
      aiCalls, stageMs,
    },
    ai, failures, change: null, caveats,
    cases: results.map(({ rulesOutcome: _r, machineMs: _m, ...rest }) => rest),
  };
}

/** Milliseconds per stage from the recorded start and end of each decision (the AI stages time themselves there). */
export async function stageMsFromDecisions(billIds: string[], nodes: string[]): Promise<Record<string, number[]>> {
  const out: Record<string, number[]> = Object.fromEntries(nodes.map((n) => [n, []]));
  if (billIds.length === 0) return out;
  const sql = getSql();
  const rows = await sql`
    SELECT node_id, started_at, ended_at FROM decisions
    WHERE invoice_id IN ${sql(billIds)} AND node_id IN ${sql(nodes)} AND ended_at IS NOT NULL`;
  for (const r of rows) {
    const ms = new Date(r.ended_at).getTime() - new Date(r.started_at).getTime();
    if (Number.isFinite(ms) && ms >= 0) out[r.node_id].push(ms);
  }
  return out;
}

/** What the trail says about the AI's own conduct on these invoices. Shared with the field report. */
export async function aiHonesty(billIds: string[]): Promise<Pick<AiValue, "aiHolds" | "aiHoldsPersonRejected" | "aiHoldsPersonApproved" | "verifierDisagreed" | "uncheckedFigureNotes" | "aiExplanations" | "challengesAnswered" | "challengesUnanswered">> {
  const empty = { aiHolds: 0, aiHoldsPersonRejected: 0, aiHoldsPersonApproved: 0, verifierDisagreed: 0, uncheckedFigureNotes: 0, aiExplanations: 0, challengesAnswered: 0, challengesUnanswered: 0 };
  if (billIds.length === 0) return empty;
  const sql = getSql();
  const rows = await sql`
    SELECT invoice_id, node_id, action_taken, reason_code, claims, model, triggered_by_question
    FROM decisions WHERE invoice_id IN ${sql(billIds)} AND node_id IN ('investigate', 'verify', 'policy', 'human_review')
    ORDER BY seq`;
  const out = { ...empty };
  const aiHeld = new Set<string>();
  for (const r of rows) {
    const claims: Array<{ text: string; tag: string }> = r.claims ? JSON.parse(r.claims) : [];
    if (r.node_id === "policy" && r.reason_code === "INVESTIGATOR_HOLD") aiHeld.add(r.invoice_id);
    if (r.node_id === "policy" && claims.some((c) => c.text.startsWith("Verifier disagreed"))) out.verifierDisagreed++;
    if ((r.node_id === "investigate" || r.node_id === "verify") && r.model) {
      out.aiExplanations++;
      // claim-check.ts adds this note when an AI explanation carries a figure found nowhere in its evidence.
      if (claims.some((c) => c.text.startsWith("Figures in this AI explanation"))) out.uncheckedFigureNotes++;
      if (r.triggered_by_question) {
        if (claims.some((c) => c.text.startsWith("Answer to "))) out.challengesAnswered++;
        else out.challengesUnanswered++;
      }
    }
  }
  out.aiHolds = aiHeld.size;
  for (const r of rows) {
    if (r.node_id !== "human_review" || !aiHeld.has(r.invoice_id)) continue;
    // human-review.ts records a person's choice as human_approved / human_rejected; an approval that credit
    // changed is recorded as no_payment or paid_less_credit.
    if (r.action_taken === "human_rejected") out.aiHoldsPersonRejected++;
    else if (["human_approved", "no_payment", "paid_less_credit"].includes(r.action_taken)) out.aiHoldsPersonApproved++;
  }
  return out;
}

function round(x: number | null): number | null {
  return x === null ? null : Math.round(x);
}
function round1(x: number | null): number | null {
  return x === null ? null : Math.round(x * 10) / 10;
}
