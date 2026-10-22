/**
 * Bugs that testing against realistic input found, what they would have cost, and the change that fixed each. Kept
 * in the code so it ships with what it describes. Each fixed bug has a test or a lab case that would catch it again
 * (`guard`). Newest first. Add an entry when a lab case, a test pack or live use finds a bug, in the same change as
 * the fix.
 */

export interface FoundByEval {
  date: string;
  /** What went wrong, as a person using VeriBook would have seen it. */
  found: string;
  /** What it would have cost if it had shipped or stayed. */
  risk: "money" | "trust" | "time";
  /** How it was found. */
  how: "lab run" | "test pack" | "live use" | "code review";
  fix: string;
  /** The lab case id or test file that now guards it. */
  guard: string;
}

export const FOUND_BY_EVALS: FoundByEval[] = [
  { date: "2026-10-22", found: "INV-0001 was approved and paid although INV-001, the same bill from the same vendor for the same amount, had been paid already.", risk: "money", how: "lab run",
    fix: "Near-duplicates (same number written differently, or same amount, lines and date within a day: spec §2 EXC-05) are held for a person.", guard: "lab: trick-near-duplicate; tests/duplicate-key.test.ts" },
  { date: "2026-10-22", found: "An invoice held for a future date gave 'Clean Match' as its reason.", risk: "trust", how: "lab run",
    fix: "The date and flagged-vendor checks record their own reasons (INVOICE_DATE, VENDOR_FLAGGED).", guard: "lab: trick-future-date; money rule 'A held invoice records why'" },
  { date: "2026-10-22", found: "Tax of exactly 2 points over the printed rate was blocked instead of escalated; a price exactly 2% over was held instead of approved (rounding in the computer's arithmetic).", risk: "time", how: "lab run",
    fix: "Variances are compared at 9 decimals, so a boundary takes the lenient side as spec §4.5 says.", guard: "lab: tax-overcharged, price-exactly-2pct; tests/decision-matrix.test.ts" },
  { date: "2026-10-22", found: "The audit page went blank when switching to 'Unpaid by age'.", risk: "trust", how: "live use",
    fix: "Each report tab draws only data fetched for it (PR #28).", guard: "frontend/src/components/AuditReports.jsx" },
  { date: "2026-10-22", found: "A delivery entered twice counted twice, so 10 lab coats billed against 8 delivered went through.", risk: "money", how: "test pack",
    fix: "An identical receipt is refused, and receipts beyond what was ordered are refused (PR #26).", guard: "lab: two-deliveries-overbilled; tests/purchase-orders.test.ts" },
  { date: "2026-10-22", found: "Gloves on the invoice were paired with bolts on the order because their amounts were close.", risk: "money", how: "test pack",
    fix: "Lines must be at least 30% alike by description before amounts are compared (PR #26).", guard: "lab: clean-three-lines; tests/line-match.test.ts" },
  { date: "2026-10-22", found: "One auto-approval limit applied to every currency: INR 1,06,200 was held while GBP 49,000 would have been paid.", risk: "money", how: "test pack",
    fix: "Limits per currency; a currency with no limit always goes to a person (migration 010, PR #26).", guard: "lab: currency-no-limit, inr-clean; tests/settings-guardrails.test.ts" },
  { date: "2026-10-22", found: "The AI review wrote '300 units' (2,000 were billed) and '621 x 1.91 = 1186', and the trail showed them as fact.", risk: "trust", how: "test pack",
    fix: "Every figure in an AI explanation is looked up in its evidence; one that is not there is marked unchecked.", guard: "tests/honest-wording.test.ts" },
  { date: "2026-10-22", found: "When a person challenged a decision, the AI's answer ignored the question.", risk: "trust", how: "test pack",
    fix: "The answer to the person's question comes first, or the record says it went unanswered.", guard: "tests/honest-wording.test.ts" },
  { date: "2026-10-21", found: "Reading documents: PO number '1200' taken from a heading, '30' from the payment-terms box, and an invoice whose subtotal includes its shipping row did not add up.", risk: "money", how: "test pack",
    fix: "No PO number from a heading or a neighbouring box; a subtotal that includes shipping rows is recognised (PR #25).", guard: "tests/reader-edge-cases.test.ts; eval/documents" },
  { date: "2026-10-22", found: "A paid invoice still showed the bank-change hold; 8.25% was shown as 8.3% and 0.149 as 0.15.", risk: "trust", how: "test pack",
    fix: "The hold shows only while it holds; rates and unit prices keep their real precision.", guard: "tests/test-pack-fixes.test.ts" },
];
