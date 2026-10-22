import { describe, it, expect } from "vitest";
import { invoiceNumberKey, nearDuplicateOf, type DuplicateCandidate } from "@/lib/matching/duplicate-key";
import { gateReasonCode, runPreMatchValidation, type PreMatchInput } from "@/lib/matching/pre-match-validation";
import { mismatchesFor } from "@/lib/mismatches";

/**
 * The near-duplicate check (spec §2 EXC-05's fuzzy duplicate), found missing by the lab run: INV-0001 was approved and
 * paid after INV-001, the same bill. Pure: no database.
 */

const lines = [{ description: "Industrial widget", qty: 5, unitPrice: 100 }];
const bill = (over: Partial<DuplicateCandidate> = {}): DuplicateCandidate => ({ invoiceNumber: "INV-0001", invoiceDate: "2026-10-17", total: 500, lines, ...over });

describe("invoiceNumberKey", () => {
  it("one number however it is written", () => {
    for (const n of ["INV-001", "inv 0001", "INV/1", "INV-0001", " Inv_1 "]) expect(invoiceNumberKey(n)).toBe("INV|1");
  });
  it("different numbers stay different", () => {
    expect(invoiceNumberKey("INV-12")).not.toBe(invoiceNumberKey("INV-120"));
    expect(invoiceNumberKey("2024-001")).not.toBe(invoiceNumberKey("2025-001"));
    expect(invoiceNumberKey("A-1")).not.toBe(invoiceNumberKey("B-1"));
  });
  it("a number too long for an ordinary integer is still compared exactly", () => {
    expect(invoiceNumberKey("INV-000012345678901234567890")).toBe("INV|12345678901234567890");
  });
});

describe("nearDuplicateOf", () => {
  it("the same number written differently, same amount: a near duplicate, whatever the date", () => {
    expect(nearDuplicateOf(bill(), [bill({ invoiceNumber: "INV-001", invoiceDate: "2026-08-01" })])).toMatchObject({ invoiceNumber: "INV-001", why: expect.stringMatching(/same number written differently/) });
  });
  it("a different number, but the same amount, lines and date within a day: a near duplicate", () => {
    expect(nearDuplicateOf(bill(), [bill({ invoiceNumber: "77-B", invoiceDate: "2026-10-16", total: 500.6 })])?.why).toMatch(/same amount, lines and date/);
  });
  it("not when the amount differs by more than $1, the date by more than a day, or the lines differ", () => {
    expect(nearDuplicateOf(bill(), [bill({ invoiceNumber: "INV-001", total: 501.5 })])).toBeNull();
    expect(nearDuplicateOf(bill(), [bill({ invoiceNumber: "77-B", invoiceDate: "2026-10-14" })])).toBeNull();
    expect(nearDuplicateOf(bill(), [bill({ invoiceNumber: "77-B", lines: [{ description: "Hex bolt M8", qty: 5, unitPrice: 100 }] })])).toBeNull();
    expect(nearDuplicateOf(bill(), [bill({ invoiceNumber: "77-B", lines: [{ ...lines[0], qty: 4 }] })])).toBeNull();
  });
  it("the exact same number is left to the exact check (which rejects), not reported here", () => {
    expect(nearDuplicateOf(bill(), [bill()])).toBeNull();
  });
});

describe("the check before matching", () => {
  const input = (over: Partial<PreMatchInput> = {}): PreMatchInput => ({
    invoice: { invoiceDate: "2026-10-17", currency: "USD", isStructuredInput: true, mandatoryFieldsPresent: true },
    vendor: { trustTier: "new" }, duplicateExists: false, today: "2026-10-18", ...over,
  });
  it("a near duplicate is held for a person (block), not voided like an exact one", () => {
    const near = runPreMatchValidation(input({ nearDuplicate: { invoiceNumber: "INV-001", why: "the same number written differently" } }));
    expect(near.blockingFinding).toMatchObject({ check: "duplicate", action: "block", exceptionCode: "EXC-DUPLICATE", reason: "Looks like invoice INV-001 already on file: the same number written differently" });
    expect(runPreMatchValidation(input({ duplicateExists: true, nearDuplicate: { invoiceNumber: "x", why: "y" } })).blockingFinding).toMatchObject({ action: "auto_reject" });
  });
  it("checks outside the exception taxonomy record their own reason, never none (which read 'Clean Match')", () => {
    const future = runPreMatchValidation(input({ invoice: { ...input().invoice, invoiceDate: "2026-12-01" } })).blockingFinding!;
    expect(gateReasonCode(future)).toBe("INVOICE_DATE");
    const flagged = runPreMatchValidation(input({ vendor: { trustTier: "flagged" } })).blockingFinding!;
    expect(gateReasonCode(flagged)).toBe("VENDOR_FLAGGED");
  });
  it("the invoice page names the invoice it looks like", () => {
    const views = mismatchesFor({ bill: { currency: "USD" }, validate: { claims: ["duplicate: failed - Looks like invoice INV-001 already on file: the same number written differently (INV-001 and INV-0001) for the same amount"] } } as never);
    expect(views[0]).toMatchObject({ code: "EXC-DUPLICATE", title: "Looks like one already received", points: [{ value: "Invoice INV-001: the same number written differently (INV-001 and INV-0001) for the same amount" }] });
  });
});
