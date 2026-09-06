/**
 * The authoritative per-exception severity engine — docs/ap-three-way-match-spec.md §3.1
 * (Core Decision Table) + §3.2 (Dollar-Threshold Severity Escalation, "more restrictive
 * wins") + §4.1-4.3 (precedence/cascade for co-occurring exceptions), plus EXC-13/EXC-14
 * from ALGORITHMS.md §7. This is Layer 1 — pure deterministic code, no LLM involved
 * (ENGINE.md §1). tolerance-zones.ts is NOT used here — see the scope note in that file;
 * every threshold below is sourced directly from the spec's own per-exception tables.
 *
 * CONSISTENT POLICY FOR SPEC DISCREPANCIES: while implementing this, the formal tables
 * (§3.1, §3.2) and the spec's own prose worked examples disagreed with each other multiple
 * times (documented at each occurrence below — price variance, currency, and the non-PO
 * dollar override). Rather than resolve each one ad hoc, one rule is applied everywhere:
 * **when a table and a worked example disagree, the MORE CONSERVATIVE (stricter,
 * higher-severity) outcome wins** — appropriate for a financial control, where escalating
 * an extra case to a human is a far cheaper mistake than under-escalating one. This means
 * §3.2's dollar-threshold override is always applied and combined via "more restrictive
 * wins" even where a worked example shows a lighter action than the formal table would.
 */

export type Action = "auto_approve" | "auto_reject" | "escalate_l1" | "escalate_l2" | "block" | "block_fraud_flag";

export type ExceptionCode =
  | "EXC-NO_PO" | "EXC-BEFORE_RCV" | "EXC-PRICE_VAR" | "EXC-QTY_VAR" | "EXC-DUPLICATE"
  | "EXC-NON_PO" | "EXC-CREDIT_MEMO" | "EXC-PARTIAL" | "EXC-CURRENCY" | "EXC-TAX_VAR"
  | "EXC-LAYOUT" | "EXC-FRAUD_BANK" | "EXC-BLANKET_EXCEEDED" | "EXC-UOM_MISMATCH";

/** Ordinal severity for "more restrictive wins" comparisons (spec §3.2, §4.1). */
const SEVERITY_RANK: Record<Action, number> = {
  auto_approve: 0,
  escalate_l1: 1,
  escalate_l2: 2,
  block: 3,
  auto_reject: 3, // decisively terminal, same practical severity tier as block — see note below
  block_fraud_flag: 4,
};

/**
 * Note on auto_reject vs block: they're both severity-rank 3 (below block_fraud_flag, above
 * escalate_l2). They're kept as distinct Action values because §3.3's System Behavior differs
 * (auto_reject = immediate, vendor notified, done; block = payment frozen, awaiting resolution)
 * — but for "which is more restrictive" comparisons, treat them as equal-tier. In practice this
 * rarely matters: EXC-DUPLICATE (the only always-auto_reject exception) is also precedence-rank
 * 2 and a cascade-stop condition (§4.3), so it's essentially never competing numerically against
 * a simultaneously-fired block from another exception — precedence already decided the outcome.
 */
/** Exported so lib/pipeline/orchestrator.ts can apply "more restrictive wins" when the Verifier disagrees (ENGINE.md §2.5). */
export function moreRestrictive(a: Action, b: Action): Action {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/** §3.2's dollar-threshold table — only these 6 exception types have a dollar-override rule. */
function dollarThresholdAction(code: ExceptionCode, amountImpact: number): Action | undefined {
  const bands = DOLLAR_THRESHOLD_TABLE[code];
  if (!bands) return undefined;
  if (amountImpact <= 100) return bands.upTo100;
  if (amountImpact <= 1000) return bands.upTo1000;
  if (amountImpact <= 10000) return bands.upTo10000;
  if (amountImpact <= 50000) return bands.upTo50000;
  return bands.over50000;
}

/** Exported so lib/agent/tools.ts's get_policy tool can serialize the real table, not a duplicate of it. */
export const DOLLAR_THRESHOLD_TABLE: Partial<Record<ExceptionCode, { upTo100: Action; upTo1000: Action; upTo10000: Action; upTo50000: Action; over50000: Action }>> = {
  "EXC-PRICE_VAR": { upTo100: "auto_approve", upTo1000: "escalate_l1", upTo10000: "escalate_l1", upTo50000: "escalate_l2", over50000: "block" },
  "EXC-QTY_VAR": { upTo100: "auto_approve", upTo1000: "escalate_l1", upTo10000: "escalate_l1", upTo50000: "escalate_l2", over50000: "block" },
  "EXC-TAX_VAR": { upTo100: "auto_approve", upTo1000: "escalate_l1", upTo10000: "escalate_l2", upTo50000: "block", over50000: "block" },
  "EXC-NON_PO": { upTo100: "auto_approve", upTo1000: "escalate_l1", upTo10000: "escalate_l2", upTo50000: "block", over50000: "block" },
  "EXC-CURRENCY": { upTo100: "auto_approve", upTo1000: "escalate_l1", upTo10000: "escalate_l1", upTo50000: "escalate_l2", over50000: "block" },
  "EXC-BEFORE_RCV": { upTo100: "escalate_l1", upTo1000: "escalate_l1", upTo10000: "escalate_l2", upTo50000: "block", over50000: "block" },
};

/**
 * Each function below is the §3.1 Core Decision Table rule for that exception, combined with
 * the §3.2 dollar override where one exists ("more restrictive wins"). Parameter names mirror
 * the spec's own wording so each function is directly traceable to its source paragraph.
 */

export function evaluateNoPo(): Action {
  return "escalate_l2"; // §3.1: always Escalate L2, no dollar override table entry
}

export function evaluateBeforeReceipt(grnExists: boolean, gapDays: number, amountImpact: number): Action {
  const pctRule: Action = !grnExists ? "block" : gapDays > 7 ? "escalate_l1" : "escalate_l1";
  // §3.1: "Escalate L1 (GRN exists, >7d gap); Block (no GRN yet)" — note the spec's own table
  // only names ONE escalate condition (GRN exists + gap>7d); a GRN existing with a SHORT gap
  // isn't actually an exception at all (matching would have cleared it before this fires), so
  // "grnExists=true" reaching this function at all implies the >7d gap condition already held.
  return moreRestrictive(pctRule, dollarThresholdAction("EXC-BEFORE_RCV", amountImpact) ?? pctRule);
}

export function evaluatePriceVariance(variancePct: number, amountImpact: number): Action {
  // Boundary note: spec §2's own worked example (EXC-03: $45.00 -> $47.25 is EXACTLY 5.0%
  // variance) calls this case "Blocked" — but the literal table text ">5%" would put exactly
  // 5.0% into Escalate L1 instead. Real discrepancy in the source spec, found while writing
  // this. Resolved as >= (inclusive on the block side): it matches the concrete worked
  // example, and it's the more conservative choice for a financial control (when a boundary
  // is ambiguous, escalate to the stricter action, not the more lenient one).
  const pctRule: Action = variancePct >= 0.05 ? "block" : "escalate_l1"; // 2-5% OR <=$500 -> L1; >=5% OR >$500 -> Block
  const dollarRule: Action = amountImpact > 500 ? "block" : pctRule;
  const combined = moreRestrictive(pctRule, dollarRule);
  return moreRestrictive(combined, dollarThresholdAction("EXC-PRICE_VAR", amountImpact) ?? combined);
}

export function evaluateQuantityVariance(variancePct: number, varianceUnits: number, amountImpact: number): Action {
  const pctRule: Action = variancePct > 0.05 || varianceUnits > 2 ? "block" : "escalate_l1";
  return moreRestrictive(pctRule, dollarThresholdAction("EXC-QTY_VAR", amountImpact) ?? pctRule);
}

export function evaluateDuplicate(): Action {
  return "auto_reject"; // §3.1: always, no exceptions
}

export function evaluateNonPo(amount: number, vendorWhitelisted: boolean): Action {
  // Discrepancy note: spec §2's own worked example (a $6,500 non-PO consulting invoice) says
  // "Escalated to L1" — but §3.2's dollar-threshold table puts $1,001-$10,000 for EXC-NON_PO
  // at Escalate L2, which is stricter. Per the conservative-wins policy above, this function
  // returns escalate_l2 for that $6,500 case, not L1 — deliberately not matching the example.
  if (amount <= 2500 && vendorWhitelisted) {
    // Being whitelisted is NOT a blanket exemption from the dollar-override table — a
    // whitelisted vendor's $2,000 invoice still gets escalated to L2, since the dollar
    // table's own <=$1,000 auto-approve band doesn't cover it. Only genuinely small amounts
    // (<=$100) clear both the whitelist carve-out AND the dollar table as auto-approve.
    const dollarRule = dollarThresholdAction("EXC-NON_PO", amount) ?? "auto_approve";
    return moreRestrictive("auto_approve", dollarRule);
  }
  const pctRule: Action = amount > 10000 ? "escalate_l2" : "escalate_l1"; // $2,501-$10K L1; >$10K L2
  return moreRestrictive(pctRule, dollarThresholdAction("EXC-NON_PO", amount) ?? pctRule);
}

export function evaluateCreditMemo(netAmount: number): Action {
  return netAmount >= 0 ? "auto_approve" : "escalate_l1";
}

export function evaluatePartial(): Action {
  return "auto_approve"; // §3.1: always — partial matching is expected behavior
}

export function evaluateCurrency(unsupported: boolean, rateVariancePct: number, amountImpact: number): Action {
  if (unsupported) return "block";
  // Boundary note: spec §2's own worked example (EXC-09: 1.3% FX rate variance) calls this
  // "Escalate L1" and cites "within 2% tolerance for FX" — but no 2% FX-specific threshold
  // exists anywhere in the formal §3.1/§3.2 tables, which only define a 1% L1-vs-L2 boundary.
  // Deliberately NOT following that worked example here: the formal table is the more
  // precisely specified, internally-referenced source of truth, and the narrative example
  // appears to invent an unreferenced threshold — likely a writing error in the source spec,
  // not an intentional override. At 1.3% this implementation returns escalate_l2, not L1.
  const pctRule: Action = rateVariancePct > 0.01 ? "escalate_l2" : "escalate_l1";
  return moreRestrictive(pctRule, dollarThresholdAction("EXC-CURRENCY", amountImpact) ?? pctRule);
}

export function evaluateTaxVariance(rateDiffPct: number, amountDiff: number): Action {
  const pctRule: Action = rateDiffPct > 0.02 || amountDiff > 100 ? "block" : "escalate_l1";
  return moreRestrictive(pctRule, dollarThresholdAction("EXC-TAX_VAR", amountDiff) ?? pctRule);
}

export function evaluateLayout(): Action {
  return "block"; // §3.1: always, hard block — cannot process what cannot be read
}

export function evaluateFraudBank(): Action {
  return "block_fraud_flag"; // §3.1: always — never auto-approved regardless of amount/confidence
}

/** ALGORITHMS.md §7 — new, not in the original 12-code spec file. */
export function evaluateBlanketExceeded(overagePct: number): Action {
  return overagePct > 0.1 ? "block" : "escalate_l2";
}

export function evaluateUomMismatch(conversionPlausible: boolean): Action {
  return conversionPlausible ? "escalate_l1" : "block";
}

// --- Combining multiple co-occurring exceptions on one invoice (spec §4.1-4.3) ---

export interface ExceptionFinding {
  code: ExceptionCode;
  action: Action;
}

/**
 * Precedence order (§4.2) — lower number = higher priority. Used only to pick which exception
 * "narrates" the decision when cascade-stop logic applies or severities tie; the invoice's
 * overall ACTION is otherwise just the highest-severity action among all findings (§4.1).
 */
/** Exported for the same reason as DOLLAR_THRESHOLD_TABLE above — get_policy's single source of truth. */
export const PRECEDENCE_RANK: Record<ExceptionCode, number> = {
  "EXC-FRAUD_BANK": 1,
  "EXC-DUPLICATE": 2,
  "EXC-LAYOUT": 3,
  "EXC-NO_PO": 4,
  "EXC-NON_PO": 4,
  "EXC-CURRENCY": 5,
  "EXC-BEFORE_RCV": 6,
  "EXC-PRICE_VAR": 7,
  "EXC-QTY_VAR": 7,
  "EXC-TAX_VAR": 7,
  "EXC-CREDIT_MEMO": 7,
  "EXC-PARTIAL": 7,
  "EXC-BLANKET_EXCEEDED": 7,
  "EXC-UOM_MISMATCH": 7,
};

/** The 4 exceptions that stop the pipeline outright (§4.3) — matching/other exceptions are deferred, not ignored. */
const CASCADE_STOP_CODES: ReadonlySet<ExceptionCode> = new Set(["EXC-LAYOUT", "EXC-DUPLICATE", "EXC-FRAUD_BANK", "EXC-NO_PO"]);

export interface CombinedDecision {
  overallAction: Action;
  dominantException: ExceptionCode | null; // null only when findings is empty (clean match)
  cascaded: boolean; // true if a cascade-stop exception determined the outcome, deferring the rest
  deferredExceptions: ExceptionCode[]; // logged but not actionable until the cascade-stop clears (§4.3)
}

/**
 * Implements §4.1 (highest severity wins) + §4.2 (precedence for cascade-stop conditions) +
 * §4.3 (cascade rules: LAYOUT/DUPLICATE/FRAUD_BANK/NO_PO stop the pipeline outright).
 */
export function combineExceptions(findings: ExceptionFinding[]): CombinedDecision {
  if (findings.length === 0) {
    return { overallAction: "auto_approve", dominantException: null, cascaded: false, deferredExceptions: [] };
  }

  const cascadeStopFindings = findings.filter((f) => CASCADE_STOP_CODES.has(f.code));
  if (cascadeStopFindings.length > 0) {
    // Multiple cascade-stop conditions at once: precedence (§4.2) picks which one narrates.
    const dominant = cascadeStopFindings.reduce((best, f) => (PRECEDENCE_RANK[f.code] < PRECEDENCE_RANK[best.code] ? f : best));
    const deferred = findings.filter((f) => f.code !== dominant.code).map((f) => f.code);
    return { overallAction: dominant.action, dominantException: dominant.code, cascaded: true, deferredExceptions: deferred };
  }

  // No cascade-stop condition: full matching pipeline ran, collect ALL exceptions, take highest severity (§4.1).
  const dominant = findings.reduce((worst, f) => (SEVERITY_RANK[f.action] > SEVERITY_RANK[worst.action] ? f : worst));
  return { overallAction: dominant.action, dominantException: dominant.code, cascaded: false, deferredExceptions: [] };
}
