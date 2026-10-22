import { getSql } from "@/db/client";
import { invoiceNumberKey } from "@/lib/matching/duplicate-key";
import type { MoneySafety } from "./report";

/**
 * The rules money (and the record of it) must always obey, checked against what the database actually holds for a set of invoices. Shared
 * by the lab run (its own cases) and the field report (real invoices over a period). Each rule is a query, not a
 * re-run of the code that should have obeyed it, so a bug in that code cannot also hide its own breach.
 *
 * `billIds` is bounded by the caller (lab: its cases; field: MAX_FIELD_INVOICES).
 */

export interface RuleBreach { invoiceId: string; invoiceNumber: string; detail: string }
export interface MoneyRuleResult { key: string; rule: string; breaches: RuleBreach[] }

const EXAMPLES = 5;
const CENT = 0.01;

export async function checkMoneyRules(billIds: string[]): Promise<MoneyRuleResult[]> {
  if (billIds.length === 0) return RULES.map((r) => ({ key: r.key, rule: r.rule, breaches: [] }));
  const sql = getSql();

  const paidWithoutApproval = await sql`
    SELECT vb.id, vb.invoice_number, vb.status, SUM(pa.applied_amount)::float AS paid
    FROM vendor_bills vb JOIN payment_applications pa ON pa.vendor_bill_id = vb.id
    WHERE vb.id IN ${sql(billIds)} AND vb.status NOT IN ('posted', 'paid')
    GROUP BY vb.id, vb.invoice_number, vb.status`;

  const overpaid = await sql`
    SELECT vb.id, vb.invoice_number, vb.total_amount::float AS total,
      COALESCE((SELECT SUM(applied_amount) FROM payment_applications WHERE vendor_bill_id = vb.id), 0)::float AS paid,
      COALESCE((SELECT SUM(applied_amount) FROM credit_applications WHERE vendor_bill_id = vb.id AND credit_memo_id <> vb.id), 0)::float AS credited
    FROM vendor_bills vb
    WHERE vb.id IN ${sql(billIds)} AND vb.invoice_type = 'standard'`;

  const creditPaid = await sql`
    SELECT vb.id, vb.invoice_number, SUM(pa.applied_amount)::float AS paid
    FROM vendor_bills vb JOIN payment_applications pa ON pa.vendor_bill_id = vb.id
    WHERE vb.id IN ${sql(billIds)} AND vb.invoice_type = 'credit_memo'
    GROUP BY vb.id, vb.invoice_number`;

  const postedEntries = await sql`
    SELECT vb.id, vb.invoice_number, vb.journal_entry_id,
      (SELECT SUM(debit_amount)::float FROM journal_entry_lines WHERE entry_id = vb.journal_entry_id) AS debits,
      (SELECT SUM(credit_amount)::float FROM journal_entry_lines WHERE entry_id = vb.journal_entry_id) AS credits
    FROM vendor_bills vb
    WHERE vb.id IN ${sql(billIds)} AND vb.status IN ('posted', 'paid')`;

  const heldButPosted = await sql`
    SELECT vb.id, vb.invoice_number, vb.status
    FROM vendor_bills vb JOIN journal_entries je ON je.id = vb.journal_entry_id
    WHERE vb.id IN ${sql(billIds)} AND vb.status IN ('exception', 'void', 'processing') AND je.status = 'posted'`;

  // The hold is vendor-wide (bank-change-review.ts detectBankChangeGates): while the newest review of the vendor's current
  // account lacks a confirmed callback AND a second reviewer, none of its invoices is paid. Checked for the invoice that
  // brought the change and every invoice received after it. Still open now means any such payment went out while it was
  // open. (Invoices received before the change are not checked: they may have been paid to the old account.) "After the
  // change" compares receipt times with the invoice that brought it, both stamped by the database: the review's own
  // created_at comes from the app's clock, which can differ from the database's by seconds. A review with no source
  // invoice on record (older data) falls back to that created_at rather than being skipped.
  const paidThroughBankHold = await sql`
    SELECT vb.id, vb.invoice_number, r.status
    FROM vendor_bills vb
    JOIN vendors v ON v.id = vb.vendor_id
    JOIN LATERAL (
      SELECT status, second_reviewer_name, source_invoice_id, created_at FROM vendor_bank_change_reviews
      WHERE vendor_id = vb.vendor_id AND new_bank_last4 IS NOT DISTINCT FROM v.bank_account_last4
      ORDER BY created_at DESC LIMIT 1) r ON true
    LEFT JOIN vendor_bills src ON src.id = r.source_invoice_id
    WHERE vb.id IN ${sql(billIds)}
      AND NOT (r.status = 'callback_confirmed' AND r.second_reviewer_name IS NOT NULL)
      AND vb.received_at::timestamptz >= COALESCE(src.received_at::timestamptz, r.created_at::timestamptz)
      AND EXISTS (SELECT 1 FROM payment_applications pa WHERE pa.vendor_bill_id = vb.id)`;

  // The reason a held invoice gives is its newest decision or closing step's (a crash records R99 on the closing step
  // only). "Clean Match", or no reason at all, on a held invoice contradicts itself.
  const heldWithoutReason = await sql`
    SELECT vb.id, vb.invoice_number, p.reason_code FROM vendor_bills vb
    LEFT JOIN LATERAL (SELECT reason_code FROM decisions WHERE invoice_id = vb.id AND node_id IN ('policy', 'audit') AND superseded_by_id IS NULL ORDER BY seq DESC LIMIT 1) p ON true
    WHERE vb.id IN ${sql(billIds)} AND vb.status = 'exception' AND (p.reason_code IS NULL OR p.reason_code = 'CLEAN_MATCH')`;

  // Duplicates are looked for across the vendor's whole history, not only within `billIds`: the first copy of a
  // bill paid twice is usually older than the period being reported.
  const approved = await sql`
    SELECT vb.id, vb.vendor_id, vb.invoice_number, vb.total_amount::float AS total, vb.currency
    FROM vendor_bills vb
    WHERE vb.invoice_type = 'standard' AND vb.status IN ('posted', 'paid')
      AND vb.vendor_id IN (SELECT vendor_id FROM vendor_bills WHERE id IN ${sql(billIds)})`;

  const inScope = new Set(billIds);
  const byKey = new Map<string, Array<(typeof approved)[number]>>();
  for (const b of approved) {
    const key = `${b.vendor_id}|${invoiceNumberKey(b.invoice_number)}|${b.currency}|${Number(b.total).toFixed(2)}`;
    byKey.set(key, [...(byKey.get(key) ?? []), b]);
  }
  const duplicates: RuleBreach[] = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    for (const b of group) {
      if (!inScope.has(b.id)) continue;
      const others = group.filter((o) => o.id !== b.id).map((o) => o.invoice_number);
      duplicates.push({ invoiceId: b.id, invoiceNumber: b.invoice_number, detail: `approved, and so was ${others.join(", ")} from the same vendor for the same amount` });
    }
  }

  const found: Record<string, RuleBreach[]> = {
    paid_only_when_approved: paidWithoutApproval.map((r) => ({ invoiceId: r.id, invoiceNumber: r.invoice_number, detail: `${r.paid} paid while the invoice is '${r.status}'` })),
    never_more_than_owed: overpaid
      .filter((r) => r.paid + r.credited > r.total + CENT)
      .map((r) => ({ invoiceId: r.id, invoiceNumber: r.invoice_number, detail: `${r.paid} paid + ${r.credited} credit used against a total of ${r.total}` })),
    credit_never_paid: creditPaid.map((r) => ({ invoiceId: r.id, invoiceNumber: r.invoice_number, detail: `${r.paid} paid out on a credit memo` })),
    approved_means_balanced_entry: postedEntries
      .filter((r) => !r.journal_entry_id || r.debits == null || Math.abs(r.debits - r.credits) > CENT)
      .map((r) => ({ invoiceId: r.id, invoiceNumber: r.invoice_number, detail: r.journal_entry_id ? `entry does not balance: debits ${r.debits}, credits ${r.credits}` : "approved with no ledger entry" })),
    held_means_not_posted: heldButPosted.map((r) => ({ invoiceId: r.id, invoiceNumber: r.invoice_number, detail: `'${r.status}' but its ledger entry is posted` })),
    bank_change_holds_payment: paidThroughBankHold.map((r) => ({ invoiceId: r.id, invoiceNumber: r.invoice_number, detail: `paid while the vendor's new bank account is not cleared (check '${r.status}', or no second reviewer)` })),
    no_bill_paid_twice: duplicates,
    held_says_why: heldWithoutReason.map((r) => ({ invoiceId: r.id, invoiceNumber: r.invoice_number, detail: `held, but its recorded reason is '${r.reason_code ?? "none"}'` })),
  };
  return RULES.map((r) => ({ key: r.key, rule: r.rule, breaches: found[r.key] }));
}

const RULES: Array<{ key: string; rule: string }> = [
  { key: "paid_only_when_approved", rule: "Money goes out only on an approved invoice" },
  { key: "never_more_than_owed", rule: "Never paid more than the invoice total (payments plus credit used)" },
  { key: "credit_never_paid", rule: "A credit memo is never paid out" },
  { key: "approved_means_balanced_entry", rule: "Every approved invoice has a ledger entry that balances" },
  { key: "held_means_not_posted", rule: "A held or rejected invoice is not in the ledger" },
  { key: "bank_change_holds_payment", rule: "Nothing is paid into a new bank account before it is confirmed" },
  { key: "no_bill_paid_twice", rule: "The same bill is not approved twice (same vendor, number and amount)" },
  { key: "held_says_why", rule: "A held invoice records why it is held (never 'Clean Match')" },
];

/** The money rules as the report shows them; every breach is also a silent error, since none of them is ever intended. */
export function moneyRulesSection(results: MoneyRuleResult[]): MoneySafety["rules"] {
  return results.map((r) => ({ key: r.key, rule: r.rule, broken: r.breaches.length, examples: r.breaches.slice(0, EXAMPLES) }));
}

export function breachedInvoiceIds(results: MoneyRuleResult[]): Set<string> {
  return new Set(results.flatMap((r) => r.breaches.map((b) => b.invoiceId)));
}
