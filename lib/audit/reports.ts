import { getSql } from "@/db/client";
import { creditMemoUses, openAmountOn } from "@/lib/ledger/journal";

/**
 * The period reports an auditor asks for, built from what VeriBook already records (no new tables):
 *  - overrides: every invoice a PERSON decided (approved despite a hold, rejected, challenged), with what the checks
 *    had said, who decided, their note, and two warning signs: no note, and approved by the person who entered it;
 *  - ageing: approved invoices not yet paid, by how long past due, with unused vendor credit, tied out to the
 *    ledger's Accounts Payable balance (any difference is shown, never hidden);
 *  - received not invoiced (cut-off): goods accepted by a date that no invoice dated by then has billed, valued at
 *    the PO price: what is owed though no bill has arrived.
 * Read-only. Each row carries the invoice or PO id so the screen links it to its trail.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const DAY = 24 * 60 * 60 * 1000;
const parseClaims = (raw: unknown): string[] => {
  if (typeof raw !== "string" || !raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed.map((c: any) => String(c?.text ?? "")).filter(Boolean) : [];
};
const humanName = (agentId: string | null, actor: string | null) => actor ?? (agentId?.startsWith("human:") ? agentId.slice("human:".length) : null);

// ------------------------------------------------------------------------------------------------ overrides

export interface OverrideRow {
  decisionId: string;
  invoiceId: string;
  invoiceNumber: string;
  vendor: string;
  amount: number;
  currency: string;
  at: string;
  /** approved_despite_hold | approved | rejected | challenged */
  kind: "approved_despite_hold" | "approved" | "rejected" | "challenged";
  /** What the checks had decided before the person did, e.g. "Blocked: Price Variance". */
  checksSaid: string | null;
  by: string;
  note: string | null;
  enteredBy: string | null;
  /** Warning signs an auditor looks for. */
  flags: Array<"no_note" | "approved_own_entry">;
}

const ROUTE: Record<string, string> = {
  auto_approve: "Approved automatically", escalate_l1: "Sent to a reviewer", escalate_l2: "Sent to a reviewer (level 2)",
  block: "Blocked", block_fraud_flag: "Fraud hold", auto_reject: "Rejected automatically",
};
const KIND: Record<string, OverrideRow["kind"] | undefined> = { human_approved: "approved", human_rejected: "rejected", human_contested: "challenged" };

/** Every decision a person made between `from` and `to` (inclusive dates, YYYY-MM-DD), newest first. */
export async function overridesReport(p: { from: string; to: string; limit?: number }): Promise<OverrideRow[]> {
  const sql = getSql();
  const limit = Math.min(Math.max(p.limit ?? 500, 1), 2000);
  const humans = await sql`
    SELECT d.id, d.seq, d.invoice_id, d.action_taken, d.agent_id, d.triggered_by_actor, d.claims, d.created_at,
           vb.invoice_number, vb.total_amount, vb.currency, v.name AS vendor
    FROM decisions d JOIN vendor_bills vb ON vb.id = d.invoice_id JOIN vendors v ON v.id = vb.vendor_id
    WHERE d.node_id = 'human_review' AND d.action_taken IN ('human_approved', 'human_rejected', 'human_contested')
      AND d.created_at::date BETWEEN ${p.from}::date AND ${p.to}::date
    ORDER BY d.seq DESC LIMIT ${limit}`;
  if (humans.length === 0) return [];
  const ids = [...new Set(humans.map((h: any) => h.invoice_id as string))];
  const [policies, extracts, reasons] = await Promise.all([
    sql`SELECT invoice_id, seq, action_taken, reason_code FROM decisions WHERE node_id = 'policy' AND invoice_id IN ${sql(ids)} ORDER BY seq`,
    sql`SELECT invoice_id, agent_id, triggered_by_actor FROM decisions WHERE node_id = 'extract' AND invoice_id IN ${sql(ids)} ORDER BY seq`,
    sql`SELECT code, name FROM reason_codes`,
  ]);
  const reasonName = new Map(reasons.map((r: any) => [r.code as string, r.name as string]));
  return humans.map((h: any): OverrideRow => {
    const before = policies.filter((x: any) => x.invoice_id === h.invoice_id && Number(x.seq) < Number(h.seq)).at(-1);
    const entered = extracts.find((x: any) => x.invoice_id === h.invoice_id && humanName(x.agent_id, x.triggered_by_actor));
    const by = humanName(h.agent_id, h.triggered_by_actor) ?? "unknown";
    const enteredBy = entered ? humanName(entered.agent_id, entered.triggered_by_actor) : null;
    const note = parseClaims(h.claims)[0]?.trim() || null;
    let kind = KIND[h.action_taken]!;
    if (kind === "approved" && before && before.action_taken !== "auto_approve") kind = "approved_despite_hold";
    const flags: OverrideRow["flags"] = [];
    if (!note) flags.push("no_note");
    if ((kind === "approved" || kind === "approved_despite_hold") && enteredBy && enteredBy.trim().toLowerCase() === by.trim().toLowerCase()) flags.push("approved_own_entry");
    return {
      decisionId: h.id, invoiceId: h.invoice_id, invoiceNumber: h.invoice_number, vendor: h.vendor, amount: Number(h.total_amount), currency: h.currency,
      at: h.created_at, kind,
      checksSaid: before ? `${ROUTE[before.action_taken] ?? before.action_taken}${before.reason_code && before.reason_code !== "CLEAN_MATCH" ? `: ${reasonName.get(before.reason_code) ?? before.reason_code}` : ""}` : null,
      by, note, enteredBy, flags,
    };
  });
}

// ------------------------------------------------------------------------------------------------ ageing

export interface AgeingRow {
  invoiceId: string;
  invoiceNumber: string;
  vendor: string;
  currency: string;
  open: number;
  dueDate: string;
  daysPastDue: number;
  bucket: "not_due" | "1-30" | "31-60" | "61-90" | "90+";
}
export interface AgeingReport {
  asOf: string;
  rows: AgeingRow[];
  /** Per currency: open invoices by bucket, unused vendor credit, and what is owed net. */
  totals: Array<{ currency: string; buckets: Record<AgeingRow["bucket"], number>; open: number; unusedCredit: number; net: number }>;
  /** The ledger's Accounts Payable balance (credits less debits on account 2000) against the net owed. */
  ledger: { apBalance: number; netOwed: number; difference: number; note: string | null };
}

/** "Net 45" -> 45; anything unreadable -> 30. */
function termsDays(code: string | null): number {
  const m = /(\d{1,3})/.exec(code ?? "");
  return m ? Number(m[1]) : 30;
}
const bucketOf = (days: number): AgeingRow["bucket"] => (days <= 0 ? "not_due" : days <= 30 ? "1-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+");

/** Approved invoices not yet paid in full, as of `asOf` (YYYY-MM-DD), and the tie-out to the ledger. */
export async function ageingReport(p: { asOf: string }): Promise<AgeingReport> {
  const sql = getSql();
  const asOfMs = Date.parse(`${p.asOf}T00:00:00Z`);
  const bills = await sql`
    SELECT vb.id, vb.invoice_number, vb.status, vb.total_amount, vb.currency, vb.invoice_date, vb.due_date, v.name AS vendor, v.payment_terms_code
    FROM vendor_bills vb JOIN vendors v ON v.id = vb.vendor_id
    WHERE vb.status IN ('approved', 'posted') AND vb.invoice_type = 'standard' ORDER BY vb.invoice_date`;
  const rows: AgeingRow[] = [];
  for (const b of bills) {
    const open = await openAmountOn(sql, { id: b.id, status: b.status, total_amount: Number(b.total_amount) });
    if (open <= 0) continue;
    const due = b.due_date ? String(b.due_date) : new Date(Date.parse(`${b.invoice_date}T00:00:00Z`) + termsDays(b.payment_terms_code) * DAY).toISOString().slice(0, 10);
    const days = Math.round((asOfMs - Date.parse(`${due}T00:00:00Z`)) / DAY);
    rows.push({ invoiceId: b.id, invoiceNumber: b.invoice_number, vendor: b.vendor, currency: b.currency, open, dueDate: due, daysPastDue: Math.max(0, days), bucket: bucketOf(days) });
  }
  const credits = await sql`SELECT id, currency FROM vendor_bills WHERE invoice_type = 'credit_memo' AND journal_entry_id IS NOT NULL`;
  const unusedByCurrency = new Map<string, number>();
  for (const c of credits) {
    const { unused } = await creditMemoUses(sql, c.id);
    unusedByCurrency.set(c.currency, round2((unusedByCurrency.get(c.currency) ?? 0) + unused));
  }
  const currencies = [...new Set([...rows.map((r) => r.currency), ...unusedByCurrency.keys()])].sort();
  const totals = currencies.map((currency) => {
    const mine = rows.filter((r) => r.currency === currency);
    const buckets = { not_due: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 } as Record<AgeingRow["bucket"], number>;
    for (const r of mine) buckets[r.bucket] = round2(buckets[r.bucket] + r.open);
    const open = round2(mine.reduce((s, r) => s + r.open, 0));
    const unusedCredit = unusedByCurrency.get(currency) ?? 0;
    return { currency, buckets, open, unusedCredit, net: round2(open - unusedCredit) };
  });
  const [ap] = await sql`
    SELECT COALESCE(SUM(jl.credit_amount), 0) - COALESCE(SUM(jl.debit_amount), 0) AS balance
    FROM journal_entry_lines jl JOIN chart_of_accounts a ON a.id = jl.account_id JOIN journal_entries je ON je.id = jl.entry_id
    WHERE a.account_number = '2000' AND je.status = 'posted'`;
  const apBalance = round2(Number(ap.balance));
  const netOwed = round2(totals.reduce((s, t) => s + t.net, 0));
  return {
    asOf: p.asOf, rows, totals,
    ledger: {
      apBalance, netOwed, difference: round2(apBalance - netOwed),
      note: currencies.length > 1 ? "Invoices are in more than one currency and there are no exchange rates, so the ledger total adds different currencies: compare per currency." : null,
    },
  };
}

// ------------------------------------------------------------------------------------------------ received not invoiced

export interface ReceivedNotInvoicedRow {
  poId: string;
  poNumber: string;
  vendor: string;
  currency: string;
  lineNumber: number;
  description: string;
  received: number;
  invoiced: number;
  notInvoiced: number;
  unitPrice: number;
  value: number;
}

/**
 * Goods accepted on or before `asOf` that no invoice dated on or before `asOf` has billed (rejected invoices do not
 * count as billing), per PO line, valued at the PO price. Invoice lines count against the PO line the match paired
 * them with; a line billed in another unit counts as written (no conversion here).
 */
export async function receivedNotInvoicedReport(p: { asOf: string }): Promise<{ asOf: string; rows: ReceivedNotInvoicedRow[]; totals: Array<{ currency: string; value: number }> }> {
  const sql = getSql();
  const lines = await sql`
    SELECT pl.id, pl.line_number, pl.description, pl.unit_price, po.id AS po_id, po.po_number, po.currency, v.name AS vendor,
      (SELECT COALESCE(SUM(grl.qty_received), 0) FROM goods_receipt_lines grl JOIN goods_receipts gr ON gr.id = grl.goods_receipt_id
        WHERE grl.po_line_id = pl.id AND gr.condition = 'accepted' AND gr.receipt_date::date <= ${p.asOf}::date) AS received,
      (SELECT COALESCE(SUM(bl.qty_invoiced), 0) FROM vendor_bill_lines bl JOIN vendor_bills vb ON vb.id = bl.vendor_bill_id
        WHERE bl.po_line_id = pl.id AND vb.status <> 'void' AND vb.invoice_type = 'standard' AND vb.invoice_date::date <= ${p.asOf}::date) AS invoiced
    FROM purchase_order_lines pl JOIN purchase_orders po ON po.id = pl.po_id JOIN vendors v ON v.id = po.vendor_id
    ORDER BY po.po_number, pl.line_number`;
  const rows = lines
    .map((l: any): ReceivedNotInvoicedRow => {
      const received = Number(l.received), invoiced = Number(l.invoiced);
      const notInvoiced = Math.max(0, received - invoiced);
      return { poId: l.po_id, poNumber: l.po_number, vendor: l.vendor, currency: l.currency, lineNumber: Number(l.line_number), description: l.description,
        received, invoiced, notInvoiced, unitPrice: Number(l.unit_price), value: round2(notInvoiced * Number(l.unit_price)) };
    })
    .filter((r) => r.notInvoiced > 0);
  const totals = [...new Set(rows.map((r) => r.currency))].sort().map((currency) => ({ currency, value: round2(rows.filter((r) => r.currency === currency).reduce((s, r) => s + r.value, 0)) }));
  return { asOf: p.asOf, rows, totals };
}

// ------------------------------------------------------------------------------------------------ CSV

/** Rows as CSV for an auditor's spreadsheet: a header from the first row's keys; arrays joined with "; ". */
export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const keys = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    const s = Array.isArray(v) ? v.join("; ") : v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [keys.join(","), ...rows.map((r) => keys.map((k) => cell(r[k])).join(","))].join("\n");
}
