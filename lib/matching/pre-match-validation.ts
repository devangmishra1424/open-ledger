import type { ExceptionCode } from "@/lib/matching/decision-matrix";

/**
 * Pre-match validation gate — docs/ap-three-way-match-spec.md §1.2: six checks that "must
 * pass before matching begins." Layer 1, pure and deterministic (ENGINE.md §1); takes
 * plain pre-fetched values, not DB row shapes or live DB access — the caller (pipeline
 * orchestrator) is responsible for the duplicate-invoice lookup and any other query this
 * needs, same pattern as line-match.ts.
 *
 * Evaluated in the spec's own table order, since earlier checks are effectively
 * prerequisites for later ones to mean anything (a currency field pulled from an unreadable
 * document isn't a real signal). All six are always evaluated and reported — not
 * short-circuited — so the caller gets the full picture in one pass, but `blockingFinding`
 * names the first failure in table order as the one that actually gates progression.
 *
 * Two of the six checks don't map onto the formal §2/§3 exception taxonomy at all (vendor
 * active status, invoice date validity) — the spec gives them their own plain-English
 * routing ("Block, escalate to AP supervisor", "Flag for review (anti-fraud)") rather than
 * an EXC- code. Forcing them into `ExceptionCode` would violate the exact 1:1 mapping that
 * type already has against the 14 real exception codes (see DESIGN.md), so they're modeled
 * as their own `action` values instead.
 */

export type PreMatchCheck =
  | "readability"
  | "duplicate"
  | "vendor_status"
  | "currency"
  | "invoice_date"
  | "mandatory_fields";

export type PreMatchAction = "block" | "auto_reject" | "flag_for_review";

export interface PreMatchFinding {
  check: PreMatchCheck;
  passed: boolean;
  /** Only set when passed=false. */
  action?: PreMatchAction;
  /** Only set when passed=false AND this check maps onto the formal exception taxonomy. */
  exceptionCode?: ExceptionCode;
  /** Only set when passed=false. */
  reason?: string;
}

export interface PreMatchInput {
  invoice: {
    invoiceDate: string; // ISO date string
    currency: string;
    isStructuredInput: boolean; // true for XML/EDI; false for OCR'd documents
    ocrConfidence?: number; // 0-1, meaningful only when isStructuredInput is false
    mandatoryFieldsPresent: boolean; // computed by the extraction stage against the schema
  };
  vendor: { trustTier: "trusted" | "new" | "flagged" };
  duplicateExists: boolean; // caller already checked vendor_id + invoice_number
  today: string; // ISO date string, injected for deterministic testing rather than Date.now()
}

export interface PreMatchResult {
  passed: boolean;
  findings: PreMatchFinding[];
  blockingFinding?: PreMatchFinding;
}

/** Spec §1.2 doesn't enumerate the actual list — this is the Layer 1 config for it. */
export const SUPPORTED_CURRENCIES = ["USD", "EUR", "GBP", "CAD"] as const;

export function isCurrencySupported(currency: string): boolean {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(currency);
}

function checkReadability(invoice: PreMatchInput["invoice"]): PreMatchFinding {
  const passed = invoice.isStructuredInput || (invoice.ocrConfidence ?? 0) >= 0.85;
  if (passed) return { check: "readability", passed: true };
  return {
    check: "readability",
    passed: false,
    action: "block",
    exceptionCode: "EXC-LAYOUT",
    reason: `OCR confidence ${((invoice.ocrConfidence ?? 0) * 100).toFixed(0)}% is below the 85% threshold and the input is not structured (XML/EDI)`,
  };
}

function checkDuplicate(duplicateExists: boolean): PreMatchFinding {
  if (!duplicateExists) return { check: "duplicate", passed: true };
  return {
    check: "duplicate",
    passed: false,
    action: "auto_reject",
    exceptionCode: "EXC-DUPLICATE",
    reason: "An existing invoice already exists for this vendor_id + invoice_number",
  };
}

function checkVendorStatus(vendor: PreMatchInput["vendor"]): PreMatchFinding {
  if (vendor.trustTier !== "flagged") return { check: "vendor_status", passed: true };
  return {
    check: "vendor_status",
    passed: false,
    action: "block",
    reason: "Vendor is flagged — not eligible for automated processing until cleared",
  };
}

function checkCurrency(currency: string): PreMatchFinding {
  if (isCurrencySupported(currency)) return { check: "currency", passed: true };
  return {
    check: "currency",
    passed: false,
    action: "block",
    exceptionCode: "EXC-CURRENCY",
    reason: `Currency '${currency}' is not in the supported list (${SUPPORTED_CURRENCIES.join(", ")})`,
  };
}

/** Spec §1.2: invoice_date must be within [today - 365 days, today + 1 day]. */
function checkInvoiceDate(invoiceDate: string, today: string): PreMatchFinding {
  const invMs = new Date(invoiceDate).getTime();
  const todayMs = new Date(today).getTime();
  const dayMs = 1000 * 60 * 60 * 24;
  const passed = invMs <= todayMs + dayMs && invMs >= todayMs - 365 * dayMs;
  if (passed) return { check: "invoice_date", passed: true };
  return {
    check: "invoice_date",
    passed: false,
    action: "flag_for_review",
    reason: `Invoice date ${invoiceDate} falls outside the allowed window relative to today (${today})`,
  };
}

function checkMandatoryFields(present: boolean): PreMatchFinding {
  if (present) return { check: "mandatory_fields", passed: true };
  return {
    check: "mandatory_fields",
    passed: false,
    action: "block",
    exceptionCode: "EXC-LAYOUT",
    reason: "One or more mandatory fields are missing per the invoice schema",
  };
}

export function runPreMatchValidation(input: PreMatchInput): PreMatchResult {
  const findings: PreMatchFinding[] = [
    checkReadability(input.invoice),
    checkDuplicate(input.duplicateExists),
    checkVendorStatus(input.vendor),
    checkCurrency(input.invoice.currency),
    checkInvoiceDate(input.invoice.invoiceDate, input.today),
    checkMandatoryFields(input.invoice.mandatoryFieldsPresent),
  ];

  const blockingFinding = findings.find((f) => !f.passed);
  return { passed: !blockingFinding, findings, blockingFinding };
}
