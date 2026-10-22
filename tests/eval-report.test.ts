import { describe, it, expect } from "vitest";
import {
  changeSince, evaluateTargets, percentile, summaryOf, verdictOf, REPORT_VERSION,
  type EvalReport, type MoneySafety, type TargetResult,
} from "@/lib/evals/report";
import { evaluatePriceVariance, evaluateQuantityVariance, evaluateTaxVariance, ratio } from "@/lib/matching/decision-matrix";
import { classifyPriceVariance, classifyTaxRateVariance } from "@/lib/matching/tolerance-zones";

/** The report's verdict rules (lib/evals/report.ts) and the boundary rounding the lab run found missing. Pure. */

const money = (over: Partial<MoneySafety> = {}): MoneySafety => ({ checked: 10, wronglyPaid: 0, wronglyHeld: 0, silentErrors: 0, rules: [], ...over });

describe("targets and verdict", () => {
  it("a lab run that meets every target passes", () => {
    const t = evaluateTargets({ kind: "lab", money: money(), cases: { judged: 40, right: 40 }, p95MachineSeconds: 7 });
    expect(t.map((x) => x.key)).toEqual(["wrongly_paid", "silent_errors", "policy_agreement", "p95_machine_seconds"]);
    expect(verdictOf(t)).toBe("pass");
  });

  it("one wrongly paid invoice fails the run, and says what to do", () => {
    const t = evaluateTargets({ kind: "lab", money: money({ wronglyPaid: 1, silentErrors: 1 }), cases: { judged: 40, right: 39 }, p95MachineSeconds: 7 });
    expect(verdictOf(t)).toBe("fail");
    const paid = t.find((x) => x.key === "wrongly_paid")!;
    expect(paid).toMatchObject({ met: false, actual: "1" });
    expect(paid.ifMissed).toMatch(/Stop automatic approval/);
    expect(summaryOf("fail", t, 40, "lab")).toMatch(/^Missed: invoices paid that should not have been; mistakes with no warning on the record; cases decided as the written policy says/);
  });

  it("nothing measured is never a pass", () => {
    const t = evaluateTargets({ kind: "field", money: money({ checked: 0 }), overrides: { decided: 0, approved: 0 }, p95MachineSeconds: null });
    expect(t.every((x) => x.met === null)).toBe(true);
    expect(verdictOf(t)).toBe("not_enough_data");
  });

  it("field: the override rate is a target (under 30%), with no data until a person has decided a hold", () => {
    const at = (approved: number, decided: number) => evaluateTargets({ kind: "field", money: money(), overrides: { decided, approved }, p95MachineSeconds: 3 }).find((x) => x.key === "override_rate")!;
    expect(at(2, 10)).toMatchObject({ met: true, actual: "20.0% (2 of 10)" });
    expect(at(3, 10)).toMatchObject({ met: false });
    expect(at(0, 0)).toMatchObject({ met: null });
  });

  it("slow machine time fails its target", () => {
    const t = evaluateTargets({ kind: "lab", money: money(), cases: { judged: 1, right: 1 }, p95MachineSeconds: 75 });
    expect(t.find((x) => x.key === "p95_machine_seconds")).toMatchObject({ met: false, actual: "75.0 s" });
  });
});

describe("percentile", () => {
  it("nearest rank, ignoring what is not a number; null for nothing", () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 0.95)).toBe(95);
    expect(percentile([NaN, 7], 0.95)).toBe(7);
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe("change since the last report", () => {
  const report = (cases: Array<[string, boolean]>, targets: Array<Partial<TargetResult>> = []): EvalReport => ({
    version: REPORT_VERSION, kind: "lab", mode: "rules", generatedAt: "2026-10-22T00:00:00Z", period: null, codeVersion: null,
    verdict: "pass", summary: "", targets: targets as TargetResult[], money: money(), operations: [], journeys: [],
    logistics: { invoices: 0, machineSeconds: { p50: null, p95: null, max: null }, personWaitHours: { p50: null, p95: null, decided: 0, stillWaiting: 0 }, aiCalls: 0, stageMs: [] },
    ai: { changedOutcome: null, changedRight: null, changedWrong: null, aiHolds: 0, aiHoldsPersonRejected: 0, aiHoldsPersonApproved: 0, verifierDisagreed: 0, uncheckedFigureNotes: 0, aiExplanations: 0, challengesAnswered: 0, challengesUnanswered: 0, aiFailed: 0, notes: [] },
    failures: [], change: null, caveats: [],
    cases: cases.map(([id, ok]) => ({ id, title: id, journey: "ordered", rule: "", trick: false, expected: { outcome: "approved" }, got: { outcome: ok ? "approved" : "held", reason: null, action: null, found: [], caughtBy: null }, outcomeOk: ok, reasonOk: true, actionOk: null, ms: 1, invoiceId: null })),
  });

  it("names cases that broke and cases that were fixed, and targets that moved", () => {
    const before = report([["a", true], ["b", false], ["c", true]], [{ key: "wrongly_paid", actual: "0" }]);
    const now = report([["a", false], ["b", true], ["c", true], ["new", false]], [{ key: "wrongly_paid", actual: "1" }]);
    expect(changeSince({ id: "r1", generatedAt: "2026-10-21T00:00:00Z", report: before }, now)).toEqual({
      previousId: "r1", previousAt: "2026-10-21T00:00:00Z",
      targets: [{ key: "wrongly_paid", before: "0", now: "1" }], newlyFailing: ["a"], newlyPassing: ["b"],
    });
  });
  it("nothing to compare with: no change section", () => {
    expect(changeSince(null, report([]))).toBeNull();
  });
});

describe("a variance exactly at a boundary takes the lenient side (spec §4.5)", () => {
  it("20% charged against a printed 18% is 2 points: escalate, not block (it was 2.0000000000000018 points)", () => {
    expect(0.2 - 0.18).toBeGreaterThan(0.02); // the floating-point fact that caused it
    expect(evaluateTaxVariance(0.2 - 0.18, 20)).toBe("escalate_l1");
    expect(classifyTaxRateVariance(0.2, 0.18).zone).toBe("yellow");
    expect(evaluateTaxVariance(0.2 - 0.17, 20)).toBe("block");
  });
  it("a price exactly 2% over is green; 5% exactly is still a block, as the spec's own example says", () => {
    expect(classifyPriceVariance(102, 100).zone).toBe("green");
    expect(classifyPriceVariance(102.01, 100).zone).toBe("yellow");
    expect(evaluatePriceVariance(105 / 100 - 1, 50)).toBe("block");
  });
  it("a quantity exactly 5% over (1 unit) escalates, not blocks", () => {
    expect(evaluateQuantityVariance(21 / 20 - 1, 1, 50)).toBe("escalate_l1");
  });
  it("ratio() leaves real differences alone", () => {
    expect(ratio(0.0200001)).toBe(0.0200001);
    expect(ratio(Infinity)).toBe(Infinity);
  });
});
