import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = process.env.DATABASE_PATH ?? path.join(process.cwd(), "db", "open-ledger.sqlite");

// Fresh start every time — this is a hackathon demo DB, not a production migration chain.
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const schemaSql = fs.readFileSync(path.join(process.cwd(), "db", "schema.sql"), "utf-8");
db.exec(schemaSql);

// --- Seed chart_of_accounts (DESIGN.md §4's numbering) ---
const accounts: Array<[string, string, string, string, string, number]> = [
  // id, account_number, name, account_type, normal_balance, is_control_account
  ["1000", "1000", "Operating Checking Account", "asset", "debit", 0],
  ["1010", "1010", "Petty Cash", "asset", "debit", 0],
  ["1300", "1300", "Prepaid Expenses", "asset", "debit", 0],
  ["1500", "1500", "Fixed Assets - Computer Equipment", "asset", "debit", 0],
  ["2000", "2000", "Accounts Payable", "liability", "credit", 1],
  ["2050", "2050", "GR/IR Clearing", "liability", "credit", 1],
  ["2100", "2100", "Accrued Expenses", "liability", "credit", 0],
  ["2200", "2200", "Sales Tax / VAT Payable", "liability", "credit", 0],
  ["2210", "2210", "VAT Recoverable", "asset", "debit", 0],
  ["3000", "3000", "Common Stock", "equity", "credit", 0],
  ["3100", "3100", "Retained Earnings", "equity", "credit", 0],
  ["5000", "5000", "Cost of Goods Sold", "expense", "debit", 0],
  ["6000", "6000", "Office Supplies Expense", "expense", "debit", 0],
  ["6100", "6100", "Rent Expense", "expense", "debit", 0],
  ["6200", "6200", "Utilities Expense", "expense", "debit", 0],
  ["6300", "6300", "Software / Subscriptions Expense", "expense", "debit", 0],
  ["6400", "6400", "Professional Services / Contractor Expense", "expense", "debit", 0],
  ["6500", "6500", "Travel & Entertainment", "expense", "debit", 0],
  ["6700", "6700", "Insurance Expense", "expense", "debit", 0],
  ["6900", "6900", "Depreciation Expense", "expense", "debit", 0],
  ["7100", "7100", "Interest Expense", "expense", "debit", 0],
  ["7200", "7200", "Realized FX Gain/Loss", "expense", "debit", 0],
  ["7210", "7210", "Unrealized FX Gain/Loss", "expense", "debit", 0],
];

const insertAccount = db.prepare(
  `INSERT INTO chart_of_accounts (id, account_number, name, account_type, normal_balance, is_control_account) VALUES (?,?,?,?,?,?)`
);
for (const a of accounts) insertAccount.run(...a);

// --- Seed reason_codes: the 12 EXC-* codes from docs/ap-three-way-match-spec.md, verbatim names ---
// plus EXC-13/EXC-14 (ALGORITHMS.md §7), plus CLEAN_MATCH and R99_AGENT_ERROR (ENGINE.md §5).
const reasonCodes: Array<[string, string, string]> = [
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
  ["R99_AGENT_ERROR", "Agent Error", "A pipeline stage failed after its bounded retry — surfaced for human attention, never silently dropped."],
];

const insertReason = db.prepare(`INSERT INTO reason_codes (code, name, description) VALUES (?,?,?)`);
for (const r of reasonCodes) insertReason.run(...r);

// --- Seed a single open accounting period for the demo ---
db.prepare(
  `INSERT INTO accounting_periods (id, name, start_date, end_date, status) VALUES (?,?,?,?,?)`
).run("2026-09", "2026-09", "2026-09-01", "2026-09-30", "open");

console.log(`Migrated ${DB_PATH}`);
console.log(`Seeded ${accounts.length} accounts, ${reasonCodes.length} reason codes, 1 accounting period.`);
