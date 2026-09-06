import { describe, it, expect } from "vitest";
import {
  evaluateNoPo, evaluateBeforeReceipt, evaluatePriceVariance, evaluateQuantityVariance,
  evaluateDuplicate, evaluateNonPo, evaluateCreditMemo, evaluatePartial, evaluateCurrency,
  evaluateTaxVariance, evaluateLayout, evaluateFraudBank, evaluateBlanketExceeded, evaluateUomMismatch,
  combineExceptions, type ExceptionFinding,
} from "@/lib/matching/decision-matrix";

describe("decision-matrix (docs/ap-three-way-match-spec.md §3)", () => {
  describe("per-exception rules — core table (§3.1)", () => {
    it("EXC-NO_PO always escalates L2", () => {
      expect(evaluateNoPo()).toBe("escalate_l2");
    });

    it("EXC-PRICE_VAR: 2-5% escalates L1 at low dollar impact", () => {
      expect(evaluatePriceVariance(0.03, 200)).toBe("escalate_l1");
    });
    it("EXC-PRICE_VAR: regression — exactly 5.0% is Block, matching spec's own worked example ($45.00 -> $47.25), not the literal '>5%' text", () => {
      expect(evaluatePriceVariance(0.05, 2.25)).toBe("block");
    });
    it("EXC-PRICE_VAR: >$500 line impact blocks even if percentage is small", () => {
      expect(evaluatePriceVariance(0.01, 600)).toBe("block");
    });

    it("EXC-QTY_VAR: within 5% and 2 units escalates L1", () => {
      expect(evaluateQuantityVariance(0.03, 1, 100)).toBe("escalate_l1");
    });
    it("EXC-QTY_VAR: over 2 units blocks even if percentage is tiny", () => {
      expect(evaluateQuantityVariance(0.001, 10, 100)).toBe("block");
    });
    it("EXC-QTY_VAR: matches spec's own worked example (188 accepted vs 200 invoiced, 12 units, 6.38%) -> Block", () => {
      expect(evaluateQuantityVariance(12 / 188, 12, 100)).toBe("block");
    });

    it("EXC-DUPLICATE always auto-rejects", () => {
      expect(evaluateDuplicate()).toBe("auto_reject");
    });

    it("EXC-NON_PO: auto-approves a small whitelisted invoice (within the dollar table's own <=$100 auto-approve band too)", () => {
      expect(evaluateNonPo(80, true)).toBe("auto_approve");
    });
    it("EXC-NON_PO: a whitelisted vendor does NOT bypass the dollar-override table at a higher amount — being whitelisted isn't a blanket exemption from a legitimate dollar-risk signal", () => {
      expect(evaluateNonPo(2000, true)).toBe("escalate_l2");
    });
    it("EXC-NON_PO: at $6,500 the dollar-override table (Escalate L2) wins over the base rule (L1), per the conservative-wins policy — deliberately NOT matching the spec's own worked example, which says L1", () => {
      expect(evaluateNonPo(6500, false)).toBe("escalate_l2");
    });
    it("EXC-NON_PO: at $800 both the base rule and the dollar table's <=$1,000 band agree on L1", () => {
      expect(evaluateNonPo(800, false)).toBe("escalate_l1");
    });
    it("EXC-NON_PO: at $15,000 the dollar-override table (Block) is stricter than the base rule (Escalate L2), so Block wins", () => {
      expect(evaluateNonPo(15000, false)).toBe("block");
    });

    it("EXC-CREDIT_MEMO: auto-approves when net >= 0", () => {
      expect(evaluateCreditMemo(0)).toBe("auto_approve");
      expect(evaluateCreditMemo(500)).toBe("auto_approve");
    });
    it("EXC-CREDIT_MEMO: escalates L1 when net < 0 (vendor owes us)", () => {
      expect(evaluateCreditMemo(-1500)).toBe("escalate_l1");
    });

    it("EXC-PARTIAL always auto-approves", () => {
      expect(evaluatePartial()).toBe("auto_approve");
    });

    it("EXC-CURRENCY: unsupported currency always blocks", () => {
      expect(evaluateCurrency(true, 0, 0)).toBe("block");
    });
    it("EXC-CURRENCY: <=1% variance escalates L1", () => {
      expect(evaluateCurrency(false, 0.005, 100)).toBe("escalate_l1");
    });
    it("EXC-CURRENCY: regression — deliberately does NOT follow the spec's own worked example at 1.3% (which claims L1 citing an unreferenced '2% tolerance'); the formal table's 1% boundary makes this Escalate L2", () => {
      expect(evaluateCurrency(false, 0.013, 100)).toBe("escalate_l2");
    });

    it("EXC-TAX_VAR: matches spec's own worked example (8.25% expected vs 10.00% actual = 1.75pp) -> Escalate L1", () => {
      expect(evaluateTaxVariance(0.0175, 50)).toBe("escalate_l1");
    });
    it("EXC-TAX_VAR: >2pp diff blocks", () => {
      expect(evaluateTaxVariance(0.025, 50)).toBe("block");
    });
    it("EXC-TAX_VAR: >$100 amount diff blocks even if the rate diff is small", () => {
      expect(evaluateTaxVariance(0.005, 150)).toBe("block");
    });

    it("EXC-LAYOUT always blocks", () => {
      expect(evaluateLayout()).toBe("block");
    });
    it("EXC-FRAUD_BANK always blocks with fraud flag", () => {
      expect(evaluateFraudBank()).toBe("block_fraud_flag");
    });

    it("EXC-BLANKET_EXCEEDED (ALGORITHMS.md §7): <=10% overage escalates L2, matching its own worked example (3% overage)", () => {
      expect(evaluateBlanketExceeded(0.03)).toBe("escalate_l2");
    });
    it("EXC-BLANKET_EXCEEDED: >10% overage blocks", () => {
      expect(evaluateBlanketExceeded(0.15)).toBe("block");
    });
    it("EXC-UOM_MISMATCH: plausible conversion escalates L1", () => {
      expect(evaluateUomMismatch(true)).toBe("escalate_l1");
    });
    it("EXC-UOM_MISMATCH: incompatible units blocks", () => {
      expect(evaluateUomMismatch(false)).toBe("block");
    });
  });

  describe("dollar-threshold override — 'more restrictive wins' (§3.2)", () => {
    it("a small percentage variance still gets escalated if the dollar impact is large (EXC-PRICE_VAR)", () => {
      // 1% variance alone would be well under the 2% L1 floor (would be a clean match by
      // percentage), but $60,000 impact should force Block per the dollar-override table.
      expect(evaluatePriceVariance(0.01, 60000)).toBe("block");
    });
    it("a percentage that would already Block is never downgraded by a small dollar amount", () => {
      expect(evaluatePriceVariance(0.08, 50)).toBe("block"); // 8% alone blocks; $50 alone would auto-approve — restrictive wins
    });
  });

  describe("combining co-occurring exceptions (§4.1, §4.2, §4.3)", () => {
    it("clean invoice with zero findings auto-approves", () => {
      const r = combineExceptions([]);
      expect(r.overallAction).toBe("auto_approve");
      expect(r.dominantException).toBeNull();
    });

    it("matches the spec's own 3-simultaneous-exceptions worked example (§4.1): all Block -> overall Block", () => {
      const findings: ExceptionFinding[] = [
        { code: "EXC-PRICE_VAR", action: evaluatePriceVariance(0.072, 1800) },
        { code: "EXC-QTY_VAR", action: evaluateQuantityVariance(0.053, 10, 1000) },
        { code: "EXC-TAX_VAR", action: evaluateTaxVariance(0.025, 200) },
      ];
      const r = combineExceptions(findings);
      expect(r.overallAction).toBe("block");
      expect(r.cascaded).toBe(false); // none of these three are cascade-stop codes
    });

    it("a cascade-stop exception (FRAUD_BANK) takes precedence over co-occurring matching exceptions, which are deferred not ignored (§4.3)", () => {
      const findings: ExceptionFinding[] = [
        { code: "EXC-PRICE_VAR", action: "escalate_l1" },
        { code: "EXC-FRAUD_BANK", action: "block_fraud_flag" },
      ];
      const r = combineExceptions(findings);
      expect(r.overallAction).toBe("block_fraud_flag");
      expect(r.dominantException).toBe("EXC-FRAUD_BANK");
      expect(r.cascaded).toBe(true);
      expect(r.deferredExceptions).toEqual(["EXC-PRICE_VAR"]);
    });

    it("precedence order resolves two simultaneous cascade-stop conditions (§4.2): FRAUD_BANK beats DUPLICATE", () => {
      const findings: ExceptionFinding[] = [
        { code: "EXC-DUPLICATE", action: "auto_reject" },
        { code: "EXC-FRAUD_BANK", action: "block_fraud_flag" },
      ];
      const r = combineExceptions(findings);
      expect(r.dominantException).toBe("EXC-FRAUD_BANK");
    });

    it("LAYOUT beats a matching exception but loses to DUPLICATE/FRAUD_BANK per the precedence order", () => {
      const findings: ExceptionFinding[] = [
        { code: "EXC-LAYOUT", action: "block" },
        { code: "EXC-QTY_VAR", action: "escalate_l1" },
      ];
      expect(combineExceptions(findings).dominantException).toBe("EXC-LAYOUT");
    });
  });
});
