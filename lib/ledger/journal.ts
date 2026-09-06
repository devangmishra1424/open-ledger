import { randomUUID, createHash } from "node:crypto";
import type { TransactionSql } from "postgres";
import { getSql } from "@/db/client";

/**
 * The two AP journal entries (DESIGN.md §5.3) — always separate rows, never one mutable
 * status flag:
 *   - postBillApproval: Dr 6xxx Expense (bill line's own gl_account_id, or its PO line's) —
 *     Cr 2000 Accounts Payable.
 *   - postPayment: Dr 2000 Accounts Payable — Cr 1000 Cash. Supports split/partial payment
 *     across multiple vendor_bills via the `applications` array.
 *
 * KNOWN SIMPLIFICATION (stated per the brief, not silently skipped): DESIGN.md §5.3 also
 * describes a goods-receipt accrual (Dr Inventory/Expense — Cr 2050 GR/IR Clearing) that
 * postBillApproval would then clear (Dr 2050 GR/IR — Cr 2000 AP) instead of hitting the
 * expense account directly, for PO-linked bills. That branch needs the accrual amount
 * already posted against the linked PO's receipts, which nothing in this codebase posts yet
 * (lib/pipeline/match-stage.ts computes match findings from goods_receipts but never journals
 * against them) — building it here would mean inventing an accrual-tracking query this PR
 * has no real data to drive. Both PO and non-PO bills post the plain Dr Expense — Cr AP entry
 * below; wiring GR/IR clearing in is additive once a goods-receipt posting step exists.
 */

const JOURNAL_LOCK_KEY = 4271839650; // fixed advisory-lock key for journal_entries writes — see decisions.ts's HASH_CHAIN_LOCK_KEY for the same double-write-race rationale, applied here to entry_number/balance instead of the hash chain.

/** Rounding tolerance for float-stored currency amounts (REAL columns) — half a cent. */
const BALANCE_EPSILON = 0.005;

export interface JournalLineDraft {
  accountId: string;
  debitAmount: number;
  creditAmount: number;
  currencyAmount: number;
  baseCurrencyAmount: number;
  vendorId?: string;
}

export interface JournalEntryDraft {
  entryDate: string;
  memo: string;
  sourceType: "vendor_bill" | "payment";
  sourceId: string;
  currency: string;
  exchangeRate: number;
  idempotencyKey: string;
  lines: JournalLineDraft[];
}

/**
 * Deterministic per source_type+source_id+action, per DESIGN.md §5.3 — unique-indexed on
 * journal_entries.idempotency_key so a retried posting call never double-posts.
 */
export function computeIdempotencyKey(sourceType: string, sourceId: string, action: string): string {
  return createHash("sha256").update(`${sourceType}:${sourceId}:${action}`).digest("hex");
}

/** Throws rather than silently rounding — an unbalanced entry is a real data bug, not noise. */
export function assertBalanced(lines: JournalLineDraft[]): void {
  const debitSum = lines.reduce((s, l) => s + l.debitAmount, 0);
  const creditSum = lines.reduce((s, l) => s + l.creditAmount, 0);
  if (Math.abs(debitSum - creditSum) > BALANCE_EPSILON) {
    throw new Error(`journal entry not balanced: debits ${debitSum} !== credits ${creditSum}`);
  }
}

export interface BillApprovalDraftInput {
  billId: string;
  invoiceNumber: string;
  currency: string;
  exchangeRate: number;
  totalAmount: number;
  taxTotal: number;
  apAccountId: string;
  /** Resolved tax account (e.g. via the bill line's tax_code_id, or a 2210 fallback) — required only when taxTotal > 0. */
  taxAccountId: string | null;
  lines: Array<{ accountId: string; amount: number }>;
  entryDate: string;
}

/**
 * Pure builder — no DB access — so the balance/shape logic is unit-testable without a live
 * Postgres connection. Builds one debit line per bill line (its expense amount), an optional
 * tax debit line (bill.tax_total, since vendor_bill_lines has no per-line tax_amount column —
 * only the header-level aggregate, per lib/pipeline/match-stage.ts's own note on the same gap),
 * and a single AP credit line for the full total_amount so the entry balances by construction
 * against real row totals — a real data inconsistency (line amounts that don't sum to
 * subtotal+tax) surfaces as assertBalanced() throwing, not a silently wrong posting.
 */
export function buildBillApprovalDraft(input: BillApprovalDraftInput): JournalEntryDraft {
  const lines: JournalLineDraft[] = input.lines.map((l) => ({
    accountId: l.accountId,
    debitAmount: l.amount,
    creditAmount: 0,
    currencyAmount: l.amount,
    baseCurrencyAmount: l.amount * input.exchangeRate,
  }));

  if (input.taxTotal > 0) {
    if (!input.taxAccountId) {
      throw new Error(`buildBillApprovalDraft: bill '${input.billId}' has tax_total > 0 but no tax account could be resolved`);
    }
    lines.push({
      accountId: input.taxAccountId,
      debitAmount: input.taxTotal,
      creditAmount: 0,
      currencyAmount: input.taxTotal,
      baseCurrencyAmount: input.taxTotal * input.exchangeRate,
    });
  }

  lines.push({
    accountId: input.apAccountId,
    debitAmount: 0,
    creditAmount: input.totalAmount,
    currencyAmount: input.totalAmount,
    baseCurrencyAmount: input.totalAmount * input.exchangeRate,
  });

  assertBalanced(lines);

  return {
    entryDate: input.entryDate,
    memo: `Bill approval: ${input.invoiceNumber}`,
    sourceType: "vendor_bill",
    sourceId: input.billId,
    currency: input.currency,
    exchangeRate: input.exchangeRate,
    idempotencyKey: computeIdempotencyKey("vendor_bill", input.billId, "bill_approval"),
    lines,
  };
}

export interface PaymentDraftInput {
  paymentId: string;
  totalAmount: number;
  currency: string;
  exchangeRate: number;
  cashAccountId: string;
  applications: Array<{ vendorBillId: string; appliedAmount: number; apAccountId: string; vendorId: string }>;
  entryDate: string;
}

/**
 * Pure builder — one AP debit line per application (so split/partial payment across multiple
 * vendor_bills is just multiple lines), one Cash credit line for the payment total.
 * assertBalanced() doubles as the "applications must sum to the payment total" check: the
 * credit side IS payment.total_amount, so if the applications don't add up, the throw fires.
 */
export function buildPaymentDraft(input: PaymentDraftInput): JournalEntryDraft {
  if (input.applications.length === 0) {
    throw new Error(`buildPaymentDraft: payment '${input.paymentId}' has no applications`);
  }

  const lines: JournalLineDraft[] = input.applications.map((a) => ({
    accountId: a.apAccountId,
    debitAmount: a.appliedAmount,
    creditAmount: 0,
    currencyAmount: a.appliedAmount,
    baseCurrencyAmount: a.appliedAmount * input.exchangeRate,
    vendorId: a.vendorId,
  }));

  lines.push({
    accountId: input.cashAccountId,
    debitAmount: 0,
    creditAmount: input.totalAmount,
    currencyAmount: input.totalAmount,
    baseCurrencyAmount: input.totalAmount * input.exchangeRate,
  });

  assertBalanced(lines);

  return {
    entryDate: input.entryDate,
    memo: `Payment ${input.paymentId}`,
    sourceType: "payment",
    sourceId: input.paymentId,
    currency: input.currency,
    exchangeRate: input.exchangeRate,
    idempotencyKey: computeIdempotencyKey("payment", input.paymentId, "payment_posting"),
    lines,
  };
}

async function resolvePeriodId(sql: TransactionSql<{}>, entryDate: string): Promise<string> {
  const rows = await sql`
    SELECT id FROM accounting_periods
    WHERE start_date <= ${entryDate} AND end_date >= ${entryDate} AND status = 'open'
  `;
  if (rows.length === 0) throw new Error(`no open accounting period covers date '${entryDate}' — cannot post a journal entry`);
  return rows[0].id;
}

/** Runs inside the advisory-locked transaction, so concurrent posters can't both compute the same number. */
async function nextEntryNumber(sql: TransactionSql<{}>): Promise<string> {
  const rows = await sql`SELECT COUNT(*)::int as n FROM journal_entries`;
  return `JE-${String(Number(rows[0].n) + 1).padStart(6, "0")}`;
}

async function insertJournalEntryAndLines(
  sql: TransactionSql<{}>,
  draft: JournalEntryDraft,
  entryId: string,
  entryNumber: string,
  periodId: string,
  postedAt: string
): Promise<void> {
  await sql`
    INSERT INTO journal_entries (id, entry_number, entry_date, period_id, memo, source_type, source_id,
      status, posted_by, posted_at, currency, exchange_rate, idempotency_key, created_at)
    VALUES (${entryId}, ${entryNumber}, ${draft.entryDate}, ${periodId}, ${draft.memo}, ${draft.sourceType}, ${draft.sourceId},
      'posted', 'system', ${postedAt}, ${draft.currency}, ${draft.exchangeRate}, ${draft.idempotencyKey}, ${postedAt})
  `;

  let lineNumber = 1;
  for (const line of draft.lines) {
    await sql`
      INSERT INTO journal_entry_lines (id, entry_id, line_number, account_id, debit_amount, credit_amount,
        currency_amount, base_currency_amount, vendor_id)
      VALUES (${randomUUID()}, ${entryId}, ${lineNumber}, ${line.accountId}, ${line.debitAmount}, ${line.creditAmount},
        ${line.currencyAmount}, ${line.baseCurrencyAmount}, ${line.vendorId ?? null})
    `;
    lineNumber++;
  }
}

async function resolveApAccountId(sql: TransactionSql<{}>, billApAccountId: string | null): Promise<string> {
  if (billApAccountId) return billApAccountId;
  const rows = await sql`SELECT id FROM chart_of_accounts WHERE account_number = '2000'`;
  if (rows.length === 0) throw new Error("could not resolve the Accounts Payable account (2000)");
  return rows[0].id;
}

export interface PostResult {
  journalEntryId: string;
  /** true if this call found an existing posting (idempotent replay) rather than inserting a new one. */
  alreadyPosted: boolean;
}

/**
 * Called by the pipeline's stage-7 "audit" node (BUILD.md §5.1) on auto-approve. Posts the
 * Dr Expense — Cr AP entry and marks the bill posted. Idempotent: a retried call for the same
 * billId returns the already-posted entry rather than inserting a second one, both via the
 * idempotency_key lookup and (belt-and-suspenders) via vendor_bills.journal_entry_id itself.
 */
export async function postBillApproval(billId: string): Promise<PostResult> {
  const sql = getSql();
  const idempotencyKey = computeIdempotencyKey("vendor_bill", billId, "bill_approval");

  const existing = await sql`SELECT id FROM journal_entries WHERE idempotency_key = ${idempotencyKey}`;
  if (existing.length > 0) return { journalEntryId: existing[0].id, alreadyPosted: true };

  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${JOURNAL_LOCK_KEY})`;

    const billRows = await tx`SELECT * FROM vendor_bills WHERE id = ${billId}`;
    if (billRows.length === 0) throw new Error(`postBillApproval: no vendor_bill found with id '${billId}'`);
    const bill = billRows[0];

    if (bill.journal_entry_id) return { journalEntryId: bill.journal_entry_id, alreadyPosted: true };

    // Re-check under the lock in case a concurrent caller committed between the first check and here.
    const raced = await tx`SELECT id FROM journal_entries WHERE idempotency_key = ${idempotencyKey}`;
    if (raced.length > 0) return { journalEntryId: raced[0].id, alreadyPosted: true };

    const lineRows = await tx`SELECT * FROM vendor_bill_lines WHERE vendor_bill_id = ${billId}`;
    if (lineRows.length === 0) throw new Error(`postBillApproval: vendor_bill '${billId}' has no lines to post`);

    const resolvedLines: Array<{ accountId: string; amount: number }> = [];
    for (const line of lineRows) {
      let accountId: string | null = line.gl_account_id;
      if (!accountId && line.po_line_id) {
        const poLineRows = await tx`SELECT gl_account_id FROM purchase_order_lines WHERE id = ${line.po_line_id}`;
        accountId = poLineRows[0]?.gl_account_id ?? null;
      }
      if (!accountId) {
        throw new Error(`postBillApproval: vendor_bill_line '${line.id}' has no gl_account_id and no PO line to fall back to`);
      }
      resolvedLines.push({ accountId, amount: line.qty_invoiced * line.unit_price });
    }

    const apAccountId = await resolveApAccountId(tx, bill.ap_account_id);

    let taxAccountId: string | null = null;
    if (bill.tax_total > 0) {
      const lineWithTaxCode = lineRows.find((l: any) => l.tax_code_id);
      if (lineWithTaxCode) {
        const taxCodeRows = await tx`SELECT tax_account_id FROM tax_codes WHERE id = ${lineWithTaxCode.tax_code_id}`;
        taxAccountId = taxCodeRows[0]?.tax_account_id ?? null;
      }
      if (!taxAccountId) {
        const fallbackRows = await tx`SELECT id FROM chart_of_accounts WHERE account_number = '2210'`;
        taxAccountId = fallbackRows[0]?.id ?? null;
      }
    }

    const entryDate = new Date().toISOString().slice(0, 10);
    const draft = buildBillApprovalDraft({
      billId,
      invoiceNumber: bill.invoice_number,
      currency: bill.currency,
      exchangeRate: bill.exchange_rate,
      totalAmount: bill.total_amount,
      taxTotal: bill.tax_total,
      apAccountId,
      taxAccountId,
      lines: resolvedLines,
      entryDate,
    });

    const periodId = await resolvePeriodId(tx, entryDate);
    const entryNumber = await nextEntryNumber(tx);
    const entryId = randomUUID();
    const postedAt = new Date().toISOString();

    await insertJournalEntryAndLines(tx, draft, entryId, entryNumber, periodId, postedAt);

    await tx`UPDATE vendor_bills SET journal_entry_id = ${entryId}, status = 'posted' WHERE id = ${billId}`;

    return { journalEntryId: entryId, alreadyPosted: false };
  });
}

export interface PaymentApplicationInput {
  vendorBillId: string;
  appliedAmount: number;
}

/**
 * Posts the Dr AP — Cr Cash entry for a payment, writes payment_applications for each
 * application (split/partial payment across multiple vendor_bills), and flips each applied
 * bill to 'paid' once its cumulative applied amount covers its total_amount. Idempotent the
 * same way as postBillApproval.
 *
 * NOTE: the `payments` table (db/schema.sql) has no currency/exchange_rate column of its own
 * (unlike purchase_orders/vendor_bills) — this posts in USD at exchange_rate 1.0. Flagged
 * explicitly rather than guessed: if payments need multi-currency later, that's a schema
 * change to agree on jointly (BUILD.md §12/shared-files rule), not something to smuggle in here.
 */
export async function postPayment(paymentId: string, applications: PaymentApplicationInput[]): Promise<PostResult> {
  if (applications.length === 0) throw new Error(`postPayment: applications must include at least one vendor_bill`);

  const sql = getSql();
  const idempotencyKey = computeIdempotencyKey("payment", paymentId, "payment_posting");

  const existing = await sql`SELECT id FROM journal_entries WHERE idempotency_key = ${idempotencyKey}`;
  if (existing.length > 0) return { journalEntryId: existing[0].id, alreadyPosted: true };

  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${JOURNAL_LOCK_KEY})`;

    const paymentRows = await tx`SELECT * FROM payments WHERE id = ${paymentId}`;
    if (paymentRows.length === 0) throw new Error(`postPayment: no payment found with id '${paymentId}'`);
    const payment = paymentRows[0];

    if (payment.journal_entry_id) return { journalEntryId: payment.journal_entry_id, alreadyPosted: true };

    const raced = await tx`SELECT id FROM journal_entries WHERE idempotency_key = ${idempotencyKey}`;
    if (raced.length > 0) return { journalEntryId: raced[0].id, alreadyPosted: true };

    const cashRows = await tx`SELECT id FROM chart_of_accounts WHERE account_number = '1000'`;
    if (cashRows.length === 0) throw new Error("postPayment: could not resolve the Cash account (1000)");
    const cashAccountId = cashRows[0].id;

    const resolvedApplications: Array<{ vendorBillId: string; appliedAmount: number; apAccountId: string; vendorId: string; totalAmount: number }> = [];
    for (const app of applications) {
      const billRows = await tx`SELECT id, ap_account_id, vendor_id, total_amount FROM vendor_bills WHERE id = ${app.vendorBillId}`;
      if (billRows.length === 0) throw new Error(`postPayment: no vendor_bill found with id '${app.vendorBillId}'`);
      const bill = billRows[0];
      const apAccountId = await resolveApAccountId(tx, bill.ap_account_id);
      resolvedApplications.push({
        vendorBillId: app.vendorBillId,
        appliedAmount: app.appliedAmount,
        apAccountId,
        vendorId: bill.vendor_id,
        totalAmount: bill.total_amount,
      });
    }

    const entryDate: string = payment.payment_date ?? new Date().toISOString().slice(0, 10);
    const draft = buildPaymentDraft({
      paymentId,
      totalAmount: payment.total_amount,
      currency: "USD",
      exchangeRate: 1.0,
      cashAccountId,
      applications: resolvedApplications,
      entryDate,
    });

    const periodId = await resolvePeriodId(tx, entryDate);
    const entryNumber = await nextEntryNumber(tx);
    const entryId = randomUUID();
    const postedAt = new Date().toISOString();

    await insertJournalEntryAndLines(tx, draft, entryId, entryNumber, periodId, postedAt);

    for (const app of resolvedApplications) {
      await tx`
        INSERT INTO payment_applications (id, payment_id, vendor_bill_id, applied_amount)
        VALUES (${randomUUID()}, ${paymentId}, ${app.vendorBillId}, ${app.appliedAmount})
      `;
    }

    await tx`UPDATE payments SET journal_entry_id = ${entryId} WHERE id = ${paymentId}`;

    for (const app of resolvedApplications) {
      const sumRows = await tx`SELECT COALESCE(SUM(applied_amount), 0) as total FROM payment_applications WHERE vendor_bill_id = ${app.vendorBillId}`;
      const totalApplied = Number(sumRows[0].total);
      if (totalApplied >= app.totalAmount - BALANCE_EPSILON) {
        await tx`UPDATE vendor_bills SET status = 'paid' WHERE id = ${app.vendorBillId}`;
      }
    }

    return { journalEntryId: entryId, alreadyPosted: false };
  });
}
