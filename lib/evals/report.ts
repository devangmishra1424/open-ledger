/**
 * One report layout for both kinds of evaluation:
 *  - "lab": hand-labelled cases run through the real pipeline in a throwaway schema (eval/decisions/run.ts). The right
 *    answer for each case comes from the written policy (docs/ap-three-way-match-spec.md), not from the code.
 *  - "field": what actually happened to real invoices over a period, read from the decision trail (lib/evals/field.ts).
 *
 * Both answer the same questions in the same order: did it meet its targets, was money kept safe, how did each
 * operation and each journey do, how long did things take, what did the AI add, and what went wrong.
 * Pure: no database access here, so the verdict rules can be tested on their own.
 */

export const REPORT_VERSION = 1;
export type ReportKind = "lab" | "field";
export type Verdict = "pass" | "fail" | "not_enough_data";

/** A measured number against its target. `met` is null when there was nothing to measure (no data is not a pass). */
export interface TargetResult {
  key: TargetKey;
  label: string;
  target: string;
  actual: string;
  met: boolean | null;
  /** What to do when it is missed, in words. */
  ifMissed: string;
}

export type TargetKey = "wrongly_paid" | "silent_errors" | "policy_agreement" | "override_rate" | "p95_machine_seconds";

export interface Targets {
  /** Invoices approved for payment that the policy says must be held or refused. */
  wronglyPaidMax: number;
  /** Wrong outcomes nothing on the record warned about, plus money-rule breaches. */
  silentErrorsMax: number;
  /** Lab only: share of cases whose outcome and reason match the written policy. */
  policyAgreementMin: number;
  /** Field only: share of held invoices a person then approved anyway. High means the checks hold too much. */
  overrideRateMax: number;
  /** Machine time per invoice, slowest 5%, in seconds (people's waiting time is reported separately). */
  p95MachineSecondsMax: number;
}

export const DEFAULT_TARGETS: Targets = {
  wronglyPaidMax: 0,
  silentErrorsMax: 0,
  policyAgreementMin: 1,
  overrideRateMax: 0.3,
  p95MachineSecondsMax: 60,
};

export interface MoneySafety {
  /** Invoices looked at by the money checks. */
  checked: number;
  wronglyPaid: number;
  /** Held although the policy says pay: costs a person's time and the vendor's patience, never money. */
  wronglyHeld: number;
  silentErrors: number;
  /** The rules money must always obey, each with how many invoices broke it. */
  /** `notChecked`: there was nothing for the rule to look at, so it is neither kept nor broken (never shown as a tick). */
  rules: Array<{ key: string; rule: string; broken: number; notChecked?: boolean; examples: Array<{ invoiceId: string; invoiceNumber: string; detail: string }> }>;
}

/** One step of the work, how often it was right (when that can be known) and how long it took. */
export interface OperationRow {
  key: string;
  label: string;
  /** What this step does, in a line. */
  does: string;
  runs: number;
  /** Lab: cases where this step did what the policy expects. Field: null (no labels), see `notes`. */
  correct: number | null;
  judged: number;
  p50Ms: number | null;
  p95Ms: number | null;
  notes: string[];
  /**
   * Lab: the two halves of `correct`, kept apart so a step that lets everything through cannot look perfect:
   * `caught` = cases this step should stop that it stopped (with the right reason); `letThrough` = cases it should
   * let pass that it let pass. Absent for a step scored another way (see `scoredAs`).
   */
  caught?: { n: number; of: number };
  letThrough?: { n: number; of: number };
  /** What `correct` counts, in words, when it is not caught + let through. */
  scoredAs?: string;
}

/** A kind of invoice followed from entry to its end. `steps` are counts still on the path after each step. */
export interface JourneyRow {
  key: string;
  label: string;
  entered: number;
  steps: Array<{ label: string; count: number }>;
  ended: { approved: number; held: number; rejected: number; refused: number; inProgress: number };
  /** Lab only: cases in this journey whose outcome matched the policy. */
  correct?: number;
}

export interface Logistics {
  invoices: number;
  machineSeconds: { p50: number | null; p95: number | null; max: number | null };
  /** From an invoice being held to a person deciding it. */
  personWaitHours: { p50: number | null; p95: number | null; decided: number; stillWaiting: number };
  aiCalls: number;
  /** Per stage, from the recorded start and end of each step. */
  stageMs: Array<{ stage: string; runs: number; p50: number | null; p95: number | null }>;
}

export interface AiValue {
  /** Lab with --ai: cases the AI review changed, and whether each change was right. */
  changedOutcome: number | null;
  changedRight: number | null;
  changedWrong: number | null;
  /** Clean matches the AI held for a person, and what the person then did. */
  aiHolds: number;
  aiHoldsPersonRejected: number;
  aiHoldsPersonApproved: number;
  verifierDisagreed: number;
  /** AI explanations carrying figures found nowhere in the records it was given. */
  uncheckedFigureNotes: number;
  aiExplanations: number;
  challengesAnswered: number;
  challengesUnanswered: number;
  /** AI steps that failed (e.g. the provider's daily quota ran out): the invoice was held for a person, as designed. Not an AI judgement. */
  aiFailed: number;
  notes: string[];
}

export interface FailureItem {
  /** Lab: the case id. Field: the invoice id. */
  id: string;
  title: string;
  kind: "wrongly_paid" | "wrongly_held" | "wrong_reason" | "wrong_level" | "money_rule" | "crash" | "stuck";
  expected: string;
  got: string;
  operation: string;
  invoiceId?: string;
}

/** One lab case, as it came out. */
export interface CaseResult {
  id: string;
  title: string;
  journey: string;
  rule: string;
  trick: boolean;
  expected: { outcome: Outcome; reason?: string; action?: string };
  got: { outcome: Outcome; reason: string | null; action: string | null; found: string[]; caughtBy: string | null };
  outcomeOk: boolean;
  reasonOk: boolean;
  actionOk: boolean | null;
  ms: number;
  invoiceId: string | null;
  /** Set when the case was changed after a run disagreed with it: what changed and why. */
  edited?: string;
  /** Set when the case could not be run at all (setup broke): never counted as a pass. */
  error?: string;
}

export type Outcome = "approved" | "held" | "rejected" | "refused";

/** A case is right only when its outcome, its reason and (where the policy fixes it) its level all match. */
export function caseRight(c: Pick<CaseResult, "outcomeOk" | "reasonOk" | "actionOk" | "error">): boolean {
  return !c.error && c.outcomeOk && c.reasonOk && c.actionOk !== false;
}

export interface ChangeSinceLast {
  previousId: string;
  previousAt: string;
  targets: Array<{ key: TargetKey; before: string; now: string }>;
  /** Lab: cases that went from right to wrong, or wrong to right. */
  newlyFailing: string[];
  newlyPassing: string[];
}

export interface EvalReport {
  version: typeof REPORT_VERSION;
  kind: ReportKind;
  generatedAt: string;
  /** Lab: "rules" or "rules+ai". Field: "field". */
  mode: "rules" | "rules+ai" | "field";
  period: { from: string; to: string } | null;
  codeVersion: string | null;
  verdict: Verdict;
  summary: string;
  targets: TargetResult[];
  money: MoneySafety;
  operations: OperationRow[];
  journeys: JourneyRow[];
  logistics: Logistics;
  ai: AiValue;
  failures: FailureItem[];
  change: ChangeSinceLast | null;
  caveats: string[];
  cases?: CaseResult[];
}

// --- numbers ---

/** Nearest-rank percentile of `values` (0 < p <= 1); null for no values. */
export function percentile(values: number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const rank = Math.ceil(p * xs.length);
  return xs[Math.min(xs.length, Math.max(1, rank)) - 1];
}

const pct = (x: number) => `${(x * 100).toFixed(x === 0 || x === 1 ? 0 : 1)}%`;

// --- targets and verdict ---

export interface TargetInputs {
  kind: ReportKind;
  money: MoneySafety;
  /** Lab: cases judged and cases fully right. */
  cases?: { judged: number; right: number };
  /** Field: held invoices a person decided, and how many of those they approved. */
  overrides?: { decided: number; approved: number };
  p95MachineSeconds: number | null;
}

export function evaluateTargets(input: TargetInputs, t: Targets = DEFAULT_TARGETS): TargetResult[] {
  const out: TargetResult[] = [];
  const { money } = input;
  out.push({
    key: "wrongly_paid", label: "Invoices paid that should not have been",
    target: `${t.wronglyPaidMax}`, actual: money.checked === 0 ? "nothing checked" : String(money.wronglyPaid),
    met: money.checked === 0 ? null : money.wronglyPaid <= t.wronglyPaidMax,
    ifMissed: "Stop automatic approval (raise the confidence threshold to 100 in Settings) and open each listed invoice before the next payment run.",
  });
  out.push({
    key: "silent_errors", label: "Mistakes with no warning on the record",
    target: `${t.silentErrorsMax}`, actual: money.checked === 0 ? "nothing checked" : String(money.silentErrors),
    met: money.checked === 0 ? null : money.silentErrors <= t.silentErrorsMax,
    ifMissed: "Each one is a check that let something through without saying so: open it from the failures list and add a lab case for it before fixing.",
  });
  if (input.kind === "lab") {
    const c = input.cases ?? { judged: 0, right: 0 };
    const share = c.judged === 0 ? null : c.right / c.judged;
    out.push({
      key: "policy_agreement", label: "Cases decided as the written policy says",
      target: `${pct(t.policyAgreementMin)}`, actual: share === null ? "no cases" : `${pct(share)} (${c.right} of ${c.judged})`,
      met: share === null ? null : share >= t.policyAgreementMin,
      ifMissed: "A change altered a decision: compare the failing cases with the policy section named on each, then fix the code or, if the policy changed, the case.",
    });
  } else {
    const o = input.overrides ?? { decided: 0, approved: 0 };
    const rate = o.decided === 0 ? null : o.approved / o.decided;
    out.push({
      key: "override_rate", label: "Held invoices a person approved anyway",
      target: `under ${pct(t.overrideRateMax)}`, actual: rate === null ? "no held invoice decided yet" : `${pct(rate)} (${o.approved} of ${o.decided})`,
      met: rate === null ? null : rate < t.overrideRateMax,
      ifMissed: "The checks hold too much: see which rule's holds are approved most often (Operations) and review its tolerance.",
    });
  }
  const p95 = input.p95MachineSeconds;
  out.push({
    key: "p95_machine_seconds", label: "Machine time per invoice (slowest 5%)",
    target: `under ${t.p95MachineSecondsMax} s`, actual: p95 === null ? "no timings" : `${p95.toFixed(1)} s`,
    met: p95 === null ? null : p95 < t.p95MachineSecondsMax,
    ifMissed: "Look at the slowest stage under Logistics; the AI review is usually the cause (the free AI tier slows down near its daily limit).",
  });
  return out;
}

/**
 * Fail if any target is missed. Pass only if the money targets were actually measured and every measured target is
 * met; a report that measured nothing about money is "not enough data", never a pass.
 */
export function verdictOf(targets: TargetResult[]): Verdict {
  if (targets.some((t) => t.met === false)) return "fail";
  const moneyMeasured = targets.filter((t) => t.key === "wrongly_paid" || t.key === "silent_errors").every((t) => t.met !== null);
  return moneyMeasured ? "pass" : "not_enough_data";
}

/** The one-line summary at the top of a report. */
export function summaryOf(verdict: Verdict, targets: TargetResult[], invoices: number, kind: ReportKind): string {
  const missed = targets.filter((t) => t.met === false).map((t) => t.label.toLowerCase());
  const what = kind === "lab" ? `${invoices} lab case${invoices === 1 ? "" : "s"}` : `${invoices} invoice${invoices === 1 ? "" : "s"}`;
  if (verdict === "pass") return `All targets met over ${what}.`;
  if (verdict === "not_enough_data") return `Not enough data to judge: ${what}, and the money checks had nothing to look at.`;
  return `Missed: ${missed.join("; ")} (over ${what}).`;
}

/** What moved since the previous report of the same kind. */
export function changeSince(previous: { id: string; generatedAt: string; report: EvalReport } | null, now: EvalReport): ChangeSinceLast | null {
  if (!previous) return null;
  const before = new Map(previous.report.targets.map((t) => [t.key, t.actual]));
  const targets = now.targets
    .filter((t) => before.has(t.key) && before.get(t.key) !== t.actual)
    .map((t) => ({ key: t.key, before: before.get(t.key)!, now: t.actual }));
  const wasRight = new Map((previous.report.cases ?? []).map((c) => [c.id, caseRight(c)]));
  const newlyFailing: string[] = [];
  const newlyPassing: string[] = [];
  for (const c of now.cases ?? []) {
    const right = caseRight(c);
    const was = wasRight.get(c.id);
    if (was === true && !right) newlyFailing.push(c.id);
    if (was === false && right) newlyPassing.push(c.id);
  }
  return { previousId: previous.id, previousAt: previous.generatedAt, targets, newlyFailing, newlyPassing };
}
