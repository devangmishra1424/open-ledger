import fs from "node:fs";
import path from "node:path";
import type postgres from "postgres";
import { activeSchema } from "./client";

type Sql = ReturnType<typeof postgres>;

/** Drop order for the default (`public`) schema, where we can't just drop the schema itself. */
export const TABLES_IN_DROP_ORDER = [
  "app_settings", "pbc_evidence_files", "pbc_requests", "reviews", "decisions", "reason_codes",
  "payment_applications", "payments", "vendor_bill_lines", "vendor_bills",
  "journal_entry_lines", "journal_entries",
  "goods_receipt_lines", "goods_receipts", "purchase_order_lines", "purchase_orders", "source_documents",
  "exchange_rates", "tax_codes", "vendor_corrections", "vendor_bank_change_reviews", "vendors",
  "accounting_periods", "chart_of_accounts",
];

// --- chart_of_accounts (DESIGN.md §4's numbering) ---
const ACCOUNTS: Array<[string, string, string, string, string, boolean]> = [
  ["1000", "1000", "Operating Checking Account", "asset", "debit", false],
  ["1010", "1010", "Petty Cash", "asset", "debit", false],
  ["1300", "1300", "Prepaid Expenses", "asset", "debit", false],
  ["1500", "1500", "Fixed Assets - Computer Equipment", "asset", "debit", false],
  ["2000", "2000", "Accounts Payable", "liability", "credit", true],
  ["2050", "2050", "GR/IR Clearing", "liability", "credit", true],
  ["2100", "2100", "Accrued Expenses", "liability", "credit", false],
  ["2200", "2200", "Sales Tax / VAT Payable", "liability", "credit", false],
  ["2210", "2210", "VAT Recoverable", "asset", "debit", false],
  ["3000", "3000", "Common Stock", "equity", "credit", false],
  ["3100", "3100", "Retained Earnings", "equity", "credit", false],
  ["5000", "5000", "Cost of Goods Sold", "expense", "debit", false],
  ["6000", "6000", "Office Supplies Expense", "expense", "debit", false],
  ["6100", "6100", "Rent Expense", "expense", "debit", false],
  ["6200", "6200", "Utilities Expense", "expense", "debit", false],
  ["6300", "6300", "Software / Subscriptions Expense", "expense", "debit", false],
  ["6400", "6400", "Professional Services / Contractor Expense", "expense", "debit", false],
  ["6500", "6500", "Travel & Entertainment", "expense", "debit", false],
  ["6700", "6700", "Insurance Expense", "expense", "debit", false],
  ["6900", "6900", "Depreciation Expense", "expense", "debit", false],
  ["7100", "7100", "Interest Expense", "expense", "debit", false],
  ["7200", "7200", "Realized FX Gain/Loss", "expense", "debit", false],
  ["7300", "7300", "Rounding and Discounts", "expense", "debit", false],
  ["7210", "7210", "Unrealized FX Gain/Loss", "expense", "debit", false],
];

// --- reason_codes: the 12 EXC-* codes from docs/ap-three-way-match-spec.md, verbatim names,
// plus EXC-13/EXC-14 (ALGORITHMS.md §7), plus EXC-UNMATCHED_LINE, plus CLEAN_MATCH, POLICY_LIMIT,
// INVESTIGATOR_HOLD and R99_AGENT_ERROR (ENGINE.md §5). ---
const REASON_CODES: Array<[string, string, string]> = [
  ["CLEAN_MATCH", "Clean Match", "3-way match within tolerance, no exception fired — required non-null reason code on every Tier 0 auto-approval."],
  ["EXC-NO_PO", "Missing Purchase Order", "Invoice has no valid PO reference, or the referenced PO is not open/approved."],
  ["EXC-BEFORE_RCV", "Invoice Before Receipt", "Invoice received before the goods receipt is posted for the referenced PO."],
  ["EXC-PRICE_VAR", "Price Variance", "Invoice unit price varies from the PO unit price beyond tolerance."],
  ["EXC-QTY_VAR", "Quantity Variance", "Invoiced quantity varies from received quantity beyond tolerance."],
  ["EXC-DUPLICATE", "Duplicate Invoice", "Exact or near-duplicate (embedding similarity) of a previously seen invoice."],
  ["EXC-NON_PO", "Non-PO Invoice", "Invoice has no PO reference and is not eligible for 3-way match; routed for GL coding instead."],
  ["EXC-CREDIT_MEMO", "Credit Memo Netting", "A credit memo must be netted against an open or future invoice from the same vendor."],
  ["EXC-PARTIAL", "Partial Payment or Partial Shipment", "Invoice covers less than the full PO due to a partial shipment, or is an explicit partial payment."],
  ["EXC-CURRENCY", "Currency Mismatch", "Invoice currency does not match the PO/receipt currency, or is an unsupported currency."],
  ["EXC-TAX_VAR", "Tax Mismatch", "Invoice tax rate or amount does not match the expected rate for the jurisdiction."],
  ["EXC-LAYOUT", "Unreadable Invoice Layout", "Invoice could not be parsed with sufficient confidence to proceed."],
  ["EXC-FRAUD_BANK", "Vendor Bank Detail Change", "Vendor's bank account changed recently — routed to the gated vendor bank-change review workflow, never auto-approved."],
  ["EXC-BLANKET_EXCEEDED", "Blanket PO Ceiling Exceeded", "Cumulative invoiced amount against a blanket PO exceeds its negotiated ceiling."],
  ["EXC-UOM_MISMATCH", "Unit-of-Measure Mismatch", "Invoice and PO line disagree on unit of measure with no conversion factor on file."],
  ["EXC-UNMATCHED_LINE", "Line Not on Purchase Order", "One or more invoice lines match no line on the referenced purchase order, for example an added fee or an item that was never ordered."],
  ["POLICY_LIMIT", "Auto-Approval Limit", "A clean match was held for a person because it exceeds the Settings amount limit or the Investigator's confidence is below the Settings threshold."],
  ["INVESTIGATOR_HOLD", "Held by AI Reviewer", "The rules found a clean match, but the Investigator recommended a stricter outcome. An AI opinion can only tighten a decision, never loosen it, so a person reviews this invoice."],
  ["R99_AGENT_ERROR", "Agent Error", "A pipeline stage failed after its bounded retry — surfaced for human attention, never silently dropped."],
];

/** `YYYY-MM` for the month `offset` months from `ref` (UTC). */
function monthId(ref: Date, offset: number): { id: string; start: string; end: string } {
  const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + offset, 1));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month = last day of this one
  const mm = String(m).padStart(2, "0");
  return { id: `${y}-${mm}`, start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(last).padStart(2, "0")}` };
}

/**
 * Open periods from 3 months back to 3 months ahead of `today` — a rolling window instead of a
 * single hard-coded month, because the demo clock moves and an approval posts with today's
 * entry date (a fixed 2026-09 period made every approval after Sept 30 fail with "no open
 * period"). Pure, exported for testing.
 */
export function rollingPeriods(today: Date): Array<{ id: string; start: string; end: string }> {
  const out = [];
  for (let offset = -3; offset <= 3; offset++) out.push(monthId(today, offset));
  return out;
}

export interface MigrateOptions {
  today?: Date;
  log?: (msg: string) => void;
}

/**
 * Rebuilds the ledger tables from db/schema.sql and seeds reference data, in whatever schema
 * `sql` is pinned to (see activeSchema() in db/client.ts).
 *
 *  - Named schema (e.g. `veribook_test`): drops and recreates the whole schema. Safe by
 *    construction — it can only name the schema this connection is pinned to.
 *  - Default schema: drops the known tables one by one. DESTRUCTIVE to the live ledger; the
 *    CLI (db/migrate.ts) refuses to call this without an explicit --yes.
 */
export async function migrateSchema(sql: Sql, opts: MigrateOptions = {}): Promise<{ schema: string; accounts: number; reasonCodes: number; periods: number }> {
  const log = opts.log ?? (() => {});
  const schema = activeSchema();

  if (schema) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await sql.unsafe(`CREATE SCHEMA "${schema}"`);
  } else {
    for (const table of TABLES_IN_DROP_ORDER) {
      await sql.unsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }
  }

  const schemaSql = fs.readFileSync(path.join(process.cwd(), "db", "schema.sql"), "utf-8");
  await sql.unsafe(schemaSql);

  for (const [id, num, name, type, bal, isControl] of ACCOUNTS) {
    await sql`INSERT INTO chart_of_accounts (id, account_number, name, account_type, normal_balance, is_control_account)
               VALUES (${id}, ${num}, ${name}, ${type}, ${bal}, ${isControl})`;
  }
  for (const [code, name, desc] of REASON_CODES) {
    await sql`INSERT INTO reason_codes (code, name, description) VALUES (${code}, ${name}, ${desc})`;
  }
  const periods = rollingPeriods(opts.today ?? new Date());
  for (const p of periods) {
    await sql`INSERT INTO accounting_periods (id, name, start_date, end_date, status)
               VALUES (${p.id}, ${p.id}, ${p.start}, ${p.end}, 'open')`;
  }
  // Default app_settings row for the Settings page.
  await sql`INSERT INTO app_settings (id) VALUES ('default')`;

  log(`Seeded ${ACCOUNTS.length} accounts, ${REASON_CODES.length} reason codes, ${periods.length} accounting periods, 1 app_settings.`);
  return { schema: schema ?? "(default)", accounts: ACCOUNTS.length, reasonCodes: REASON_CODES.length, periods: periods.length };
}
