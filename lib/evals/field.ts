import { getSql } from "@/db/client";
import { getChainStatus } from "@/lib/ledger/chain-status";
import { TITLE } from "@/lib/mismatches";
import { aiHonesty } from "./lab";
import { breachedInvoiceIds, checkMoneyRules, moneyRulesSection } from "./money-rules";
import {
  DEFAULT_TARGETS, REPORT_VERSION, evaluateTargets, percentile, summaryOf, verdictOf,
  type AiValue, type EvalReport, type FailureItem, type JourneyRow, type MoneySafety, type OperationRow, type Targets,
} from "./report";

/**
 * The field report: what actually happened to the invoices received in a period, read from what VeriBook already
 * records (the decision trail, the ledger, payments, documents, audit requests). Nothing new is tracked for it.
 *
 * Real invoices carry no labels, so it cannot say "right" or "wrong" per invoice the way the lab can. It reports what
 * can be known: the money rules (checked in the database), where invoices stopped, how often a person overruled a
 * hold (the checks holding too much), how long the machine and the people took, and what the AI did.
 *
 * Read-only. Bounded: at most MAX_FIELD_INVOICES invoices, newest first; a longer period says so in its caveats.
 */

export const MAX_FIELD_INVOICES = 5000;
const STUCK_MINUTES = 15;
const FAILURE_LIST_MAX = 25;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const MONEY_RULES = new Set(["paid_only_when_approved", "never_more_than_owed", "credit_never_paid", "bank_change_holds_payment", "no_bill_paid_twice"]);
const PERSON_APPROVED = new Set(["human_approved", "no_payment", "paid_less_credit"]);

interface Row { [k: string]: any }

/** A reason in the words the invoice pages use, for the report's notes (the owner reads these, not the codes). */
const MORE_TITLES: Record<string, string> = {
  INVOICE_DATE: "Invoice date out of range", VENDOR_FLAGGED: "Vendor flagged", POLICY_LIMIT: "Over the auto-approval limit",
  INVESTIGATOR_HOLD: "Held by the AI review", R99_AGENT_ERROR: "A step failed", CLEAN_MATCH: "Clean match",
};
export const REASON_WORDS: Record<string, string> = { ...TITLE, ...MORE_TITLES };
export const reasonWords = (code: string) => REASON_WORDS[code] ?? code;

/** Validated at the edge (the API route): `from` and `to` are YYYY-MM-DD with from <= to. */
export async function buildFieldReport(opts: { from: string; to: string; targets?: Targets; codeVersion?: string | null; now?: Date }): Promise<EvalReport> {
  if (!ISO_DATE.test(opts.from) || !ISO_DATE.test(opts.to) || opts.from > opts.to) throw new Error(`buildFieldReport: bad period ${opts.from}..${opts.to}`);
  const sql = getSql();
  const now = opts.now ?? new Date();

  const bills: Row[] = await sql`
    SELECT vb.id, vb.invoice_number, vb.status, vb.invoice_type, vb.po_id, vb.source_document_id, vb.received_at,
      EXISTS (SELECT 1 FROM goods_receipts gr WHERE gr.po_id = vb.po_id) AS has_receipt,
      -- In SQL: received_at is Postgres's own text form ("2026-10-22 10:11:12.3+00"), which JavaScript does not parse reliably.
      (vb.status = 'processing' AND vb.received_at::timestamptz < now() - make_interval(mins => ${STUCK_MINUTES})) AS stuck
    FROM vendor_bills vb
    WHERE vb.received_at::timestamptz >= ${opts.from}::date AND vb.received_at::timestamptz < (${opts.to}::date + 1)
    ORDER BY vb.received_at DESC LIMIT ${MAX_FIELD_INVOICES + 1}`;
  const truncated = bills.length > MAX_FIELD_INVOICES;
  if (truncated) bills.length = MAX_FIELD_INVOICES;
  const ids = bills.map((b) => b.id as string);

  const decisions: Row[] = ids.length === 0 ? [] : await sql`
    SELECT invoice_id, node_id, action_taken, reason_code, started_at, ended_at, model, claims, triggered_by_question, superseded_by_id
    FROM decisions WHERE invoice_id IN ${sql(ids)} ORDER BY seq`;
  const byBill = new Map<string, Row[]>();
  for (const d of decisions) byBill.set(d.invoice_id, [...(byBill.get(d.invoice_id) ?? []), d]);
  const live = (id: string) => (byBill.get(id) ?? []).filter((d) => !d.superseded_by_id);
  const lastOf = (id: string, node: string) => [...live(id)].reverse().find((d) => d.node_id === node);
  const firstOf = (id: string, node: string) => (byBill.get(id) ?? []).find((d) => d.node_id === node);
  const claimsOf = (d: Row | undefined): Array<{ text: string; tag: string }> => (d?.claims ? JSON.parse(d.claims) : []);
  const ms = (d: Row) => (d.ended_at ? new Date(d.ended_at).getTime() - new Date(d.started_at).getTime() : NaN);

  // --- per invoice: where it went ---
  interface Path { id: string; journey: string; validated: boolean | null; matchedClean: boolean | null; autoApproved: boolean; heldEver: boolean; personDecided: string | null; ended: "approved" | "held" | "rejected" | "inProgress"; machineMs: number; waitMs: number | null; found: string[] }
  const paths: Path[] = bills.map((b) => {
    const validate = lastOf(b.id, "validate");
    const match = lastOf(b.id, "match");
    const policy = firstOf(b.id, "policy");
    const human = (byBill.get(b.id) ?? []).filter((d) => d.node_id === "human_review" && d.action_taken !== "human_contested");
    const firstHuman = human[0];
    const heldAudit = (byBill.get(b.id) ?? []).find((d) => d.node_id === "audit" && d.action_taken !== "auto_approve" && !["no_payment", "paid_less_credit", "error", "payment_failed"].includes(d.action_taken));
    const machine = (byBill.get(b.id) ?? []).filter((d) => d.node_id !== "human_review").map(ms).filter(Number.isFinite);
    const found = [...new Set(claimsOf(match).map((c) => /^(EXC-[A-Z_]+): /.exec(c.text)?.[1]).filter((c): c is string => Boolean(c)))];
    if (validate && validate.action_taken !== "pass" && validate.reason_code) found.unshift(validate.reason_code);
    return {
      id: b.id,
      journey: b.invoice_type === "credit_memo" ? "credit" : !b.po_id ? "no_po" : b.has_receipt ? "ordered" : "ordered_not_received",
      validated: validate ? validate.action_taken === "pass" : null,
      matchedClean: match ? match.action_taken === "auto_approve" : null,
      autoApproved: policy?.action_taken === "auto_approve",
      heldEver: Boolean(policy && policy.action_taken !== "auto_approve"),
      personDecided: firstHuman?.action_taken ?? null,
      ended: b.status === "void" ? "rejected" : b.status === "posted" || b.status === "paid" ? "approved" : b.status === "processing" ? "inProgress" : "held",
      machineMs: machine.reduce((s, x) => s + x, 0),
      waitMs: heldAudit?.ended_at && firstHuman ? new Date(firstHuman.started_at).getTime() - new Date(heldAudit.ended_at).getTime() : null,
      found,
    };
  });

  // --- money rules, stuck invoices, the record's own integrity ---
  const ruleResults = await checkMoneyRules(ids);
  const breached = breachedInvoiceIds(ruleResults);
  const moneyBreached = new Set(ruleResults.filter((r) => MONEY_RULES.has(r.key)).flatMap((r) => r.breaches.map((b) => b.invoiceId)));
  const stuck = bills.filter((b) => b.stuck);
  const chain = await getChainStatus(now.getTime());
  // With no invoices a rule has nothing to look at: "not checked", never a tick (an empty period read as all-clear).
  const rules = moneyRulesSection(ruleResults).map((r) => (ids.length === 0 ? { ...r, notChecked: true } : r));
  rules.push({
    key: "no_invoice_stuck", rule: `No invoice is left mid-way (still processing after ${STUCK_MINUTES} minutes)`, broken: stuck.length, notChecked: ids.length === 0,
    examples: stuck.slice(0, 5).map((b) => ({ invoiceId: b.id, invoiceNumber: b.invoice_number, detail: `processing since ${b.received_at}` })),
  });
  rules.push({
    // The chain covers every decision ever recorded, not only this period's; with none recorded there is nothing to verify.
    key: "record_untampered", rule: "The decision record is unchanged since it was written (hash chain, whole record)", broken: chain.valid ? 0 : 1, notChecked: chain.checked === 0,
    examples: chain.valid ? [] : [{ invoiceId: "", invoiceNumber: "", detail: `the chain breaks at decision ${chain.brokenAt} (of ${chain.checked} checked)` }],
  });

  const decidedHolds = paths.filter((p) => p.heldEver && p.personDecided && p.personDecided !== "human_contested");
  const overridden = decidedHolds.filter((p) => PERSON_APPROVED.has(p.personDecided!));
  const money: MoneySafety = {
    checked: ids.length,
    wronglyPaid: moneyBreached.size,
    // No labels in the field: "held, then approved by a person" is the closest honest measure of an unneeded hold.
    wronglyHeld: overridden.length,
    silentErrors: new Set([...breached, ...stuck.map((b) => b.id)]).size + (chain.valid ? 0 : 1),
    rules,
  };

  const machineSeconds = paths.filter((p) => p.machineMs > 0).map((p) => p.machineMs / 1000);
  const p95Machine = percentile(machineSeconds, 0.95);
  const targets = evaluateTargets({ kind: "field", money, overrides: { decided: decidedHolds.length, approved: overridden.length }, p95MachineSeconds: p95Machine }, opts.targets ?? DEFAULT_TARGETS);
  const verdict = ids.length === 0 ? "not_enough_data" : verdictOf(targets);

  // --- operations ---
  const nodeMs = (node: string) => decisions.filter((d) => d.node_id === node).map(ms).filter(Number.isFinite);
  const opRow = (key: string, label: string, does: string, node: string | number[] | null, runs: number, notes: string[]): OperationRow => {
    const xs = Array.isArray(node) ? node : node ? nodeMs(node) : [];
    return { key, label, does, runs, judged: 0, correct: null, p50Ms: round(percentile(xs, 0.5)), p95Ms: round(percentile(xs, 0.95)), notes };
  };

  const read = bills.filter((b) => b.source_document_id);
  const readMs = read.map((b) => lastOf(b.id, "extract")).filter((d): d is Row => Boolean(d)).map(ms).filter(Number.isFinite);
  const corrections = read.flatMap((b) => claimsOf(lastOf(b.id, "extract")).map((c) => /^Corrected by [^:]+: (.+?) read as /.exec(c.text)?.[1]).filter((f): f is string => Boolean(f)));
  const correctedInvoices = read.filter((b) => claimsOf(lastOf(b.id, "extract")).some((c) => c.text.startsWith("Corrected by "))).length;
  const docs: Row[] = await sql`
    SELECT sd.purpose, COUNT(*)::int AS n,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM purchase_orders p WHERE p.source_document_id = sd.id)
        OR EXISTS (SELECT 1 FROM goods_receipts g WHERE g.source_document_id = sd.id)
        OR EXISTS (SELECT 1 FROM vendor_bills v WHERE v.source_document_id = sd.id))::int AS saved
    FROM source_documents sd
    WHERE sd.uploaded_at::timestamptz >= ${opts.from}::date AND sd.uploaded_at::timestamptz < (${opts.to}::date + 1)
    GROUP BY sd.purpose`;
  const docWords: Record<string, string> = { invoice: "invoices", purchase_order: "orders", goods_receipt: "delivery notes" };
  const readNotes = docs.map((d) => `${d.n} ${docWords[d.purpose] ?? d.purpose} read, ${d.saved} saved.`);
  if (read.length > 0) {
    readNotes.push(`${correctedInvoices} of ${read.length} invoices read from a document had a field corrected by a person before saving.`);
    const top = topCounts(corrections, 3);
    if (top.length) readNotes.push(`Most corrected: ${top.map(([f, n]) => `${f} (${n})`).join(", ")}.`);
  }

  const validateRuns = paths.filter((p) => p.validated !== null);
  const stoppedAtChecks = topCounts(paths.filter((p) => p.validated === false).flatMap((p) => p.found.slice(0, 1)), 5);
  const matchRuns = paths.filter((p) => p.matchedClean !== null);
  const ruleStats = new Map<string, { held: number; decided: number; approved: number }>();
  for (const p of paths) {
    if (!p.heldEver) continue;
    for (const code of p.found) {
      const s = ruleStats.get(code) ?? { held: 0, decided: 0, approved: 0 };
      s.held++;
      if (p.personDecided && p.personDecided !== "human_contested") s.decided++;
      if (p.personDecided && PERSON_APPROVED.has(p.personDecided)) s.approved++;
      ruleStats.set(code, s);
    }
  }
  const matchNotes = [...ruleStats.entries()].sort((a, b) => b[1].held - a[1].held).slice(0, 6)
    .map(([code, s]) => `${reasonWords(code)}: held ${s.held}${s.decided ? `, a person approved ${s.approved} of ${s.decided} decided (${Math.round((s.approved / s.decided) * 100)}%)` : ""}.`);
  const aiRuns = decisions.filter((d) => (d.node_id === "investigate" || d.node_id === "verify") && d.model).length;
  const pbc: Row[] = await sql`
    SELECT status, closed_at IS NOT NULL AS closed,
      EXTRACT(EPOCH FROM (closed_at::timestamptz - created_at::timestamptz)) / 86400 AS close_days
    FROM pbc_requests
    WHERE created_at::timestamptz >= ${opts.from}::date AND created_at::timestamptz < (${opts.to}::date + 1)`;
  const closeDays = pbc.filter((r) => r.closed && r.close_days != null).map((r) => Number(r.close_days));

  const operations: OperationRow[] = [
    opRow("reading", "Reading documents", "Reads invoices, orders and delivery notes into fields a person checks before saving.", readMs, read.length,
      readNotes.length ? readNotes : ["No documents were read in this period."]),
    opRow("validate", "Checks before matching", "Readable, not a duplicate, supported currency, sensible date, vendor not flagged.", "validate", validateRuns.length,
      stoppedAtChecks.length ? [`Stopped here: ${stoppedAtChecks.map(([c, n]) => `${reasonWords(c)} (${n})`).join(", ")}.`] : ["Nothing was stopped here."]),
    opRow("match", "Matching order, delivery and invoice", "Pairs lines and compares price, quantity, tax, units, currency, limits, credits and bank details.", "match", matchRuns.length,
      [`${matchRuns.filter((p) => p.matchedClean).length} of ${matchRuns.length} matched cleanly.`, ...matchNotes]),
    opRow("ai_review", "AI review", "Reads the evidence, recommends an outcome (it can only make it stricter) and explains it.", "investigate", aiRuns, []),
    // No timing: the policy step records its start after it has decided (orchestrator.runPolicyStage), so it reads ~0 ms.
    opRow("decide", "Deciding", "Turns the findings into one outcome and applies the owner's limits.", null, paths.filter((p) => lastOf(p.id, "policy")).length,
      [`${paths.filter((p) => p.autoApproved).length} approved without a person; ${paths.filter((p) => p.heldEver).length} held for one.`]),
    opRow("person", "People's decisions", "A person approves, rejects or challenges what was held.", "human_review", decidedHolds.length,
      decidedHolds.length ? [`Approved ${overridden.length} of ${decidedHolds.length} held invoices they decided.`] : ["No held invoice has been decided yet."]),
    opRow("post_pay", "Posting and paying", "Approved invoices go to the ledger and are paid (less any credit); nothing else moves money.", "audit", paths.filter((p) => p.ended === "approved").length,
      [ids.length === 0 ? "Nothing to check: no invoices in this period." : ruleResults.every((r) => r.breaches.length === 0) ? "Every money rule held." : `${breached.size} invoice(s) broke a rule: see Money.`]),
    opRow("audit_requests", "Auditor requests", "Requests an auditor makes, the evidence handed over, and how long it took.", null, pbc.length,
      pbc.length ? [`${pbc.filter((r) => r.closed).length} of ${pbc.length} closed${closeDays.length ? `; typical time to close ${percentile(closeDays, 0.5)!.toFixed(1)} days` : ""}.`] : ["No auditor request in this period."]),
  ];

  // --- journeys ---
  const JOURNEY_WORDS: Record<string, string> = { ordered: "Ordered and delivered", ordered_not_received: "Ordered, nothing delivered yet", no_po: "No order", credit: "Credit notes" };
  const journeys: JourneyRow[] = Object.entries(JOURNEY_WORDS).map(([key, label]) => {
    const rows = paths.filter((p) => p.journey === key);
    return {
      key, label, entered: rows.length,
      steps: [
        { label: "Passed the checks", count: rows.filter((p) => p.validated === true).length },
        { label: "Matched cleanly", count: rows.filter((p) => p.matchedClean === true).length },
        { label: "Approved without a person", count: rows.filter((p) => p.autoApproved).length },
        { label: "Decided by a person", count: rows.filter((p) => p.personDecided).length },
      ],
      ended: {
        approved: rows.filter((p) => p.ended === "approved").length, held: rows.filter((p) => p.ended === "held").length,
        rejected: rows.filter((p) => p.ended === "rejected").length, refused: 0, inProgress: rows.filter((p) => p.ended === "inProgress").length,
      },
    };
  }).filter((j) => j.entered > 0);

  // --- logistics and AI ---
  const waits = paths.map((p) => p.waitMs).filter((w): w is number => w !== null && w >= 0).map((w) => w / 3_600_000);
  const stageMs = ["extract", "validate", "match", "investigate", "verify", "audit"].map((stage) => {
    const xs = nodeMs(stage);
    return { stage, runs: xs.length, p50: round(percentile(xs, 0.5)), p95: round(percentile(xs, 0.95)) };
  }).filter((s) => s.runs > 0);
  const honesty = await aiHonesty(ids);
  const ai: AiValue = {
    changedOutcome: null, changedRight: null, changedWrong: null, ...honesty,
    notes: ["What the AI changes compared with the rules alone is measured by the lab run with --ai; the field shows its conduct on real invoices."],
  };

  const failures: FailureItem[] = [
    ...ruleResults.flatMap((r) => r.breaches.map((b) => ({ id: b.invoiceId, invoiceId: b.invoiceId, title: `${b.invoiceNumber}: ${r.rule}`, kind: "money_rule" as const, expected: r.rule, got: b.detail, operation: r.key }))),
    ...stuck.map((b) => ({ id: b.id, invoiceId: b.id, title: `${b.invoice_number}: still processing`, kind: "stuck" as const, expected: "decided within a few minutes", got: `processing since ${b.received_at}`, operation: "pipeline" })),
    ...paths.filter((p) => lastOf(p.id, "policy")?.reason_code === "R99_AGENT_ERROR").map((p) => ({
      id: p.id, invoiceId: p.id, title: `${bills.find((b) => b.id === p.id)!.invoice_number}: a step failed`, kind: "crash" as const,
      expected: "every step completes", got: "held for a person after a step failed (R99_AGENT_ERROR)", operation: "pipeline",
    })),
  ].slice(0, FAILURE_LIST_MAX);

  const caveats = [
    "Real invoices carry no right answers, so this report cannot say which decisions were wrong; the lab run does that. It reports what the record shows.",
    "'Held, then approved by a person' counts holds a person overruled. Some of those holds were still worth a look, so read it as an upper bound on unneeded holds.",
    "Machine time adds up the recorded duration of each automatic step; it leaves out time spent waiting for a person.",
    "Days in the period are UTC days (05:30 IST to 05:30 IST the next day).",
  ];
  if (truncated) caveats.unshift(`Only the newest ${MAX_FIELD_INVOICES} invoices of the period are included. Choose a shorter period for the rest.`);
  if (ids.length > 0 && ids.length < 20) caveats.push(`Only ${ids.length} invoice(s) in this period: percentages move a lot with each one.`);

  return {
    version: REPORT_VERSION, kind: "field", generatedAt: now.toISOString(), mode: "field",
    period: { from: opts.from, to: opts.to }, codeVersion: opts.codeVersion ?? null,
    verdict, summary: summaryOf(verdict, targets, ids.length, "field"),
    targets, money, operations, journeys,
    logistics: {
      invoices: ids.length,
      machineSeconds: { p50: round1(percentile(machineSeconds, 0.5)), p95: round1(p95Machine), max: round1(machineSeconds.length ? Math.max(...machineSeconds) : null) },
      personWaitHours: { p50: round1(percentile(waits, 0.5)), p95: round1(percentile(waits, 0.95)), decided: waits.length, stillWaiting: paths.filter((p) => p.ended === "held" && !p.personDecided).length },
      aiCalls: decisions.filter((d) => d.model).length, stageMs,
    },
    ai, failures, change: null, caveats,
  };
}

function topCounts(xs: string[], n: number): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}
function round(x: number | null): number | null {
  return x === null ? null : Math.round(x);
}
function round1(x: number | null): number | null {
  return x === null ? null : Math.round(x * 10) / 10;
}
