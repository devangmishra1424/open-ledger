import { describe, it, expect } from "vitest";
import { runPreMatchValidation, isCurrencySupported, type PreMatchInput } from "@/lib/matching/pre-match-validation";

function baseInput(overrides?: Partial<PreMatchInput>): PreMatchInput {
  return {
    invoice: {
      invoiceDate: "2026-09-01",
      currency: "USD",
      isStructuredInput: true,
      mandatoryFieldsPresent: true,
    },
    vendor: { trustTier: "trusted" },
    duplicateExists: false,
    today: "2026-09-06",
    ...overrides,
  };
}

describe("runPreMatchValidation (spec §1.2)", () => {
  it("a clean invoice passes every check", () => {
    const r = runPreMatchValidation(baseInput());
    expect(r.passed).toBe(true);
    expect(r.blockingFinding).toBeUndefined();
    expect(r.findings).toHaveLength(6);
    expect(r.findings.every((f) => f.passed)).toBe(true);
  });

  describe("readability", () => {
    it("structured input (XML/EDI) always passes regardless of ocrConfidence", () => {
      const r = runPreMatchValidation(baseInput({ invoice: { ...baseInput().invoice, isStructuredInput: true, ocrConfidence: 0.1 } }));
      expect(r.passed).toBe(true);
    });
    it("OCR confidence exactly at 85% passes", () => {
      const r = runPreMatchValidation(baseInput({ invoice: { ...baseInput().invoice, isStructuredInput: false, ocrConfidence: 0.85 } }));
      expect(r.passed).toBe(true);
    });
    it("OCR confidence below 85% fails with EXC-LAYOUT / block", () => {
      const r = runPreMatchValidation(baseInput({ invoice: { ...baseInput().invoice, isStructuredInput: false, ocrConfidence: 0.7 } }));
      expect(r.passed).toBe(false);
      expect(r.blockingFinding?.check).toBe("readability");
      expect(r.blockingFinding?.exceptionCode).toBe("EXC-LAYOUT");
      expect(r.blockingFinding?.action).toBe("block");
    });
    it("missing ocrConfidence on non-structured input is treated as 0, not passing", () => {
      const r = runPreMatchValidation(baseInput({ invoice: { ...baseInput().invoice, isStructuredInput: false } }));
      expect(r.passed).toBe(false);
      expect(r.blockingFinding?.check).toBe("readability");
    });
  });

  describe("duplicate", () => {
    it("fails with EXC-DUPLICATE / auto_reject when a duplicate exists", () => {
      const r = runPreMatchValidation(baseInput({ duplicateExists: true }));
      expect(r.passed).toBe(false);
      expect(r.blockingFinding?.check).toBe("duplicate");
      expect(r.blockingFinding?.exceptionCode).toBe("EXC-DUPLICATE");
      expect(r.blockingFinding?.action).toBe("auto_reject");
    });
  });

  describe("vendor_status", () => {
    it("a flagged vendor fails with block, escalate to AP supervisor (no EXC- code)", () => {
      const r = runPreMatchValidation(baseInput({ vendor: { trustTier: "flagged" } }));
      expect(r.passed).toBe(false);
      expect(r.blockingFinding?.check).toBe("vendor_status");
      expect(r.blockingFinding?.action).toBe("block");
      expect(r.blockingFinding?.exceptionCode).toBeUndefined();
    });
    it("a new (not yet trusted) vendor still passes — 'new' is not the same as 'flagged'", () => {
      const r = runPreMatchValidation(baseInput({ vendor: { trustTier: "new" } }));
      expect(r.passed).toBe(true);
    });
  });

  describe("currency", () => {
    it("USD/EUR/GBP/CAD are all supported", () => {
      for (const c of ["USD", "EUR", "GBP", "CAD"]) expect(isCurrencySupported(c)).toBe(true);
    });
    it("an unsupported currency fails with EXC-CURRENCY / block", () => {
      const r = runPreMatchValidation(baseInput({ invoice: { ...baseInput().invoice, currency: "XYZ" } }));
      expect(r.passed).toBe(false);
      expect(r.blockingFinding?.check).toBe("currency");
      expect(r.blockingFinding?.exceptionCode).toBe("EXC-CURRENCY");
      expect(r.blockingFinding?.action).toBe("block");
    });
  });

  describe("invoice_date", () => {
    it("exactly 1 day in the future passes (inclusive boundary)", () => {
      const r = runPreMatchValidation(baseInput({ invoice: { ...baseInput().invoice, invoiceDate: "2026-09-07" }, today: "2026-09-06" }));
      expect(r.passed).toBe(true);
    });
    it("2 days in the future fails with flag_for_review (no EXC- code)", () => {
      const r = runPreMatchValidation(baseInput({ invoice: { ...baseInput().invoice, invoiceDate: "2026-09-08" }, today: "2026-09-06" }));
      expect(r.passed).toBe(false);
      expect(r.blockingFinding?.check).toBe("invoice_date");
      expect(r.blockingFinding?.action).toBe("flag_for_review");
      expect(r.blockingFinding?.exceptionCode).toBeUndefined();
    });
    it("exactly 365 days in the past passes (inclusive boundary)", () => {
      const r = runPreMatchValidation(baseInput({ invoice: { ...baseInput().invoice, invoiceDate: "2025-09-06" }, today: "2026-09-06" }));
      expect(r.passed).toBe(true);
    });
    it("366 days in the past fails", () => {
      const r = runPreMatchValidation(baseInput({ invoice: { ...baseInput().invoice, invoiceDate: "2025-09-05" }, today: "2026-09-06" }));
      expect(r.passed).toBe(false);
      expect(r.blockingFinding?.check).toBe("invoice_date");
    });
  });

  describe("mandatory_fields", () => {
    it("missing mandatory fields fails with EXC-LAYOUT / block", () => {
      const r = runPreMatchValidation(baseInput({ invoice: { ...baseInput().invoice, mandatoryFieldsPresent: false } }));
      expect(r.passed).toBe(false);
      expect(r.blockingFinding?.check).toBe("mandatory_fields");
      expect(r.blockingFinding?.exceptionCode).toBe("EXC-LAYOUT");
    });
  });

  describe("ordering and full-report behavior", () => {
    it("reports all 6 findings even when multiple checks fail, not just the first", () => {
      const r = runPreMatchValidation(baseInput({ duplicateExists: true, invoice: { ...baseInput().invoice, currency: "XYZ" } }));
      expect(r.findings).toHaveLength(6);
      expect(r.findings.filter((f) => !f.passed).map((f) => f.check)).toEqual(["duplicate", "currency"]);
    });
    it("when multiple checks fail, blockingFinding is the first one in spec table order, not currency", () => {
      const r = runPreMatchValidation(baseInput({ duplicateExists: true, invoice: { ...baseInput().invoice, currency: "XYZ" } }));
      expect(r.blockingFinding?.check).toBe("duplicate");
    });
    it("readability failing first takes priority over a later currency failure", () => {
      const r = runPreMatchValidation(
        baseInput({
          invoice: { ...baseInput().invoice, isStructuredInput: false, ocrConfidence: 0.5, currency: "XYZ" },
        }),
      );
      expect(r.blockingFinding?.check).toBe("readability");
    });
  });
});
