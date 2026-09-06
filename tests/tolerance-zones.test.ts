import { describe, it, expect } from "vitest";
import {
  classifyPriceVariance,
  classifyQuantityVariance,
  classifyLineAmountVariance,
  classifyGrandTotalVariance,
  classifyTaxRateVariance,
  classifyDateGap,
} from "@/lib/matching/tolerance-zones";

describe("tolerance-zones (docs/ap-three-way-match-spec.md §1.5)", () => {
  describe("price variance", () => {
    it("exactly at the 2.0% boundary is green (tie-breaking rule, spec §4.5)", () => {
      expect(classifyPriceVariance(102, 100).zone).toBe("green"); // exactly 2%
    });
    it("just over 2% is yellow", () => {
      expect(classifyPriceVariance(102.5, 100).zone).toBe("yellow");
    });
    it("exactly at 5% is still yellow (yellow zone is inclusive up to 5.0%)", () => {
      expect(classifyPriceVariance(105, 100).zone).toBe("yellow");
    });
    it("over 5% is red", () => {
      expect(classifyPriceVariance(106, 100).zone).toBe("red");
    });
    it("matches the worked example in spec §2 EXC-03: $45.00 -> $47.25 is exactly 5.0%, escalate not block", () => {
      const r = classifyPriceVariance(47.25, 45.0);
      expect(r.variancePct).toBeCloseTo(0.05, 5);
      expect(r.zone).toBe("yellow");
    });
  });

  describe("quantity variance — the percentage AND absolute-unit combined rule", () => {
    it("small percentage but large absolute units on a huge order still escalates, not auto-clears", () => {
      // 10-unit variance on a 10,000-unit order is only 0.1% — but 10 > 2 units, so it must NOT be green.
      const r = classifyQuantityVariance(9990, 10000);
      expect(r.variancePct).toBeLessThan(0.05);
      expect(r.varianceUnits).toBe(10);
      expect(r.zone).not.toBe("green");
    });
    it("small percentage AND small absolute units is green", () => {
      expect(classifyQuantityVariance(199, 200).zone).toBe("green");
    });
    it("computes the raw variance correctly for the spec §2 EXC-04 worked example (188 accepted vs 200 invoiced)", () => {
      // IMPORTANT: this function implements §1.5's GENERAL reference table only. The spec's
      // OWN worked example calls this case "Blocked" — but that's EXC-04's specific Core
      // Decision Table rule (§3.1, line 320: "≤5% AND ≤2 units -> Escalate L1; >5% OR >2 units
      // -> Block"), not §1.5's wider yellow band (5.01%-15% -> escalate). These two tables
      // genuinely disagree in the source spec for this dimension — found while writing this
      // test, not assumed. Resolution: §1.5 is a general reference only; the actual per-
      // exception severity (including the §3.2 dollar-threshold override, "more restrictive
      // wins") is implemented separately in decision-matrix.ts, sourced from §3.1/§3.2
      // directly — never derived from this generic zone classifier. This test only checks
      // the raw numbers are computed right, not the final action.
      const r = classifyQuantityVariance(200, 188);
      expect(r.varianceUnits).toBe(12);
      expect(r.variancePct).toBeCloseTo(12 / 188, 4);
    });
  });

  describe("line amount variance — OR structure", () => {
    it("small dollar amount but large percentage still clears green via the OR", () => {
      // $10 off on a $20 line is 50% — but $10 <= $50, so the dollar leg of the OR still makes it green.
      expect(classifyLineAmountVariance(10, 20).zone).toBe("green");
    });
    it("small percentage but large dollar amount still clears green via the OR", () => {
      // 1% of $10,000 is $100 — over the flat $50, but under the 2% relative threshold.
      expect(classifyLineAmountVariance(10100, 10000).zone).toBe("green");
    });
    it("fails both legs of the OR -> not green", () => {
      expect(classifyLineAmountVariance(300, 100).zone).not.toBe("green"); // $200 over AND 200%
    });
  });

  describe("grand total variance — spec §1.4.3 worked example", () => {
    it("$100 variance auto-matches (at the boundary, inclusive)", () => {
      expect(classifyGrandTotalVariance(1100, 1000).zone).toBe("green");
    });
    it("3% variance auto-matches via the percentage leg even if the dollar amount is large", () => {
      expect(classifyGrandTotalVariance(10300, 10000).zone).toBe("green");
    });
  });

  describe("tax rate variance — absolute percentage points, not relative", () => {
    it("matches spec §2 EXC-10 worked example: 8.25% expected vs 10.00% actual = 1.75pp, escalate L1", () => {
      const r = classifyTaxRateVariance(0.1, 0.0825);
      expect(r.varianceAbs).toBeCloseTo(0.0175, 4);
      expect(r.zone).toBe("yellow");
    });
  });

  describe("date gap", () => {
    it("3 days exactly is green", () => {
      expect(classifyDateGap("2026-09-01", "2026-09-04").gapDays).toBe(3);
      expect(classifyDateGap("2026-09-01", "2026-09-04").zone).toBe("green");
    });
    it("order of the two dates doesn't matter", () => {
      const a = classifyDateGap("2026-09-01", "2026-09-10");
      const b = classifyDateGap("2026-09-10", "2026-09-01");
      expect(a.gapDays).toBe(b.gapDays);
    });
  });
});
