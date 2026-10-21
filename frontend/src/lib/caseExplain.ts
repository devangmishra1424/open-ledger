/**
 * The explanation of ONE invoice's verdict, built from what is recorded about that invoice: the facts
 * the engine found (which line, which numbers), what each AI step said and whether it changed the
 * outcome, where the invoice was routed, and what each button would do to it. The general rule for a
 * reason lives in reasonGuide.js; this is the part that is about this invoice.
 *
 * Newer records carry the engine's own fact sentences (lib/matching/finding-facts.ts). For older
 * records, the same facts are worked out from the purchase-order comparison (lib/three-way.ts), the
 * same pairing the engine matched from, and the invoice's amounts. Pure: no fetches, so it is tested
 * on its own (tests/case-explain.test.ts).
 */

export interface DecisionLike {
  nodeId: string;
  actionTaken: string | null;
  reasonCode: string | null;
  confidence: number | null;
  model: string | null;
  claims: string[];
}

interface ThreeWayLineLike {
  lineNumber: number; description: string; uom: string; qtyOrdered: number; unitPrice: number; qtyReceived: number;
  invoice: { description: string; uom: string; qty: number; unitPrice: number; amount: number } | null;
  priceVariancePct: number | null; qtyVsReceived: number | null; flags: string[];
}

export interface CaseLike {
  vendor: string;
  amount: number;
  currency: string;
  poNumber: string;
  poReference?: string | null;
  state: 'processing' | 'needs_attention' | 'approved' | 'paid' | 'rejected';
  reason: { code: string; name: string; description: string } | null;
  decisions: DecisionLike[];
  threeWay?: {
    poNumber: string; currency: string; poType: string; ceiling: number | null;
    lines: ThreeWayLineLike[];
    unmatchedInvoiceLines: Array<{ description: string; uom: string; qty: number; unitPrice: number; amount: number }>;
    receipts: Array<{ date: string; condition: string }>;
    totals: { ordered: number; received: number; invoiced: number };
  } | null;
  bankChange?: { step: string; oldBankLast4: string | null; newBankLast4: string | null } | null;
  actions?: Record<'approve' | 'reject' | 'contest', { allowed: boolean; reason?: string }>;
  summary?: { decidedBy: string | null };
  /** A credit memo lowers what is owed to the vendor and is never paid. */
  invoiceType?: 'standard' | 'credit_memo';
}

export interface Route {
  /** Short, for a chip: "Blocked". */
  label: string;
  /** What that route means for this invoice, in one sentence. */
  meaning: string;
  tone: 'good' | 'warn' | 'bad' | 'info';
}

export interface CaseExplanation {
  route: Route | null;
  /** What the checks found on this invoice, most specific first. */
  found: string[];
  /** The part of `found` that is not a mismatch between documents: a Settings limit, an AI hold, a failed step. */
  notes: string[];
  /** What each AI step said, and whether the AI changed the outcome. */
  ai: string[];
  /** What each decision button would do to this invoice. */
  choices: Record<'approve' | 'reject' | 'contest', string>;
}

const FINDING_LINE = /^(EXC-[A-Z_]+|R99_AGENT_ERROR|CLEAN_MATCH|POLICY_LIMIT|INVESTIGATOR_HOLD):\s*([a-z_0-9]+)$/;

const SEVERITY: Record<string, number> = { auto_approve: 0, escalate_l1: 1, escalate_l2: 2, block: 3, auto_reject: 3, block_fraud_flag: 4 };

const ROUTES: Record<string, Route> = {
  auto_approve: { label: 'Approved automatically', meaning: 'Every check passed, so no person was needed.', tone: 'good' },
  escalate_l1: { label: 'Reviewer', meaning: 'Routed to a reviewer: a person approves, rejects or challenges it. Nothing is paid until then.', tone: 'warn' },
  escalate_l2: { label: 'Reviewer, level 2', meaning: 'Routed to a reviewer at level 2, the level the rules give larger or riskier cases. There are no reviewer roles yet, so any reviewer can decide it. Nothing is paid until a person decides.', tone: 'warn' },
  block: { label: 'Blocked', meaning: 'Blocked: nothing is paid unless a person approves it.', tone: 'bad' },
  block_fraud_flag: { label: 'Fraud hold', meaning: 'Held as possible payment fraud: nothing is paid to this vendor until the bank change is verified by phone and signed off by a second person.', tone: 'bad' },
  auto_reject: { label: 'Rejected automatically', meaning: 'Rejected by the rules without a person: it will not be posted or paid.', tone: 'bad' },
};

/** An AI reviewer's recommended action, as the end of "recommended ...". */
const RECOMMENDS: Record<string, string> = {
  auto_approve: 'approving it automatically', escalate_l1: 'sending it to a reviewer', escalate_l2: 'sending it to a reviewer at level 2',
  block: 'blocking it', auto_reject: 'rejecting it', block_fraud_flag: 'holding it as possible fraud',
};

/** A route a recorded action names, or null for free text a model wrote. */
export function routeFor(action: string | null | undefined): Route | null {
  if (!action) return null;
  const key = action.trim().toLowerCase().replace(/[-‐-―\s]+/g, '_');
  return ROUTES[key] ?? null;
}

const norm = (a: string | null | undefined) => (a ?? '').trim().toLowerCase().replace(/[-‐-―\s]+/g, '_');

export function money(n: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency, maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(n);
  } catch {
    return `${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 })} ${currency}`;
  }
}
const pct = (x: number) => `${(Math.abs(x) * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
const qty = (n: number) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 });

function last<T>(items: T[], pred: (t: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (pred(items[i])) return items[i];
  return undefined;
}

/** The engine's own sentences on a match record: every claim that is not a "CODE: action" line. */
function recordedFacts(match: DecisionLike | undefined): string[] {
  return (match?.claims ?? []).filter((c) => !FINDING_LINE.test(c.trim()));
}

/** What a check found, worked out from the comparison table for a record that predates recorded facts. */
function derivedFacts(code: string, inv: CaseLike): string[] {
  const tw = inv.threeWay;
  const cur = tw?.currency || inv.currency;
  switch (code) {
    case 'EXC-PRICE_VAR':
      return (tw?.lines ?? []).filter((l) => l.invoice && (l.flags.includes('price_over') || l.flags.includes('price_under'))).map((l) => {
        const over = l.invoice!.unitPrice > l.unitPrice;
        const diff = Math.abs(l.invoice!.unitPrice - l.unitPrice) * l.invoice!.qty;
        return `PO line ${l.lineNumber} "${l.description}": billed ${money(l.invoice!.unitPrice, cur)} per ${l.uom} against the order's ${money(l.unitPrice, cur)}, ${pct(l.priceVariancePct ?? 0)} ${over ? 'above' : 'below'} it (2% is tolerated). At the billed quantity of ${qty(l.invoice!.qty)} that is ${money(diff, cur)} ${over ? 'more' : 'less'} than agreed.`;
      });
    case 'EXC-QTY_VAR':
      return (tw?.lines ?? []).filter((l) => l.invoice && (l.flags.includes('qty_over_received') || l.flags.includes('qty_over_ordered'))).map((l) =>
        `PO line ${l.lineNumber} "${l.description}": ordered ${qty(l.qtyOrdered)}, received in good condition ${qty(l.qtyReceived)}, billed ${qty(l.invoice!.qty)}. That bills ${qty(Math.max(0, l.invoice!.qty - l.qtyReceived))} ${l.uom} more than has arrived, worth ${money(Math.max(0, l.invoice!.qty - l.qtyReceived) * l.unitPrice, cur)} at the order price.`);
    case 'EXC-BEFORE_RCV':
      return tw && tw.receipts.filter((r) => r.condition === 'accepted').length === 0
        ? [`No delivery is recorded against purchase order ${tw.poNumber} yet, so nothing on this invoice is confirmed as arrived. Recording the goods receipt on Orders checks the invoice again on its own.`]
        : [`The invoice is dated well before the first delivery against purchase order ${tw?.poNumber ?? inv.poNumber} (more than 7 days counts).`];
    case 'EXC-UNMATCHED_LINE': {
      const ls = tw?.unmatchedInvoiceLines ?? [];
      if (ls.length === 0) return [];
      const total = ls.reduce((s, l) => s + Math.abs(l.amount), 0);
      return [`${ls.length === 1 ? 'One invoice line is' : `${ls.length} invoice lines are`} not on purchase order ${tw!.poNumber} at all: ${ls.map((l) => `"${l.description}" (${qty(l.qty)} x ${money(l.unitPrice, cur)} = ${money(l.amount, cur)})`).join('; ')}. ${money(total, cur)} is billed for things nobody ordered.`];
    }
    case 'EXC-UOM_MISMATCH': {
      const billed = tw?.unmatchedInvoiceLines ?? [];
      const open = (tw?.lines ?? []).filter((l) => !l.invoice);
      if (billed.length === 0 || open.length === 0) return [];
      return [`Invoice line "${billed[0].description}" is billed per ${billed[0].uom}, while the order line it looks like, "${open[0].description}", is per ${open[0].uom}, and no conversion between the two is on file for this vendor, so the quantities cannot be compared automatically.`];
    }
    case 'EXC-BLANKET_EXCEEDED':
      return tw?.ceiling != null
        ? [`Blanket order ${tw.poNumber} may be billed up to ${money(tw.ceiling, cur)} in total. This invoice is ${money(inv.amount, inv.currency)}${inv.amount > tw.ceiling ? `, which alone is ${money(inv.amount - tw.ceiling, cur)} (${pct((inv.amount - tw.ceiling) / tw.ceiling)}) over the ceiling` : ', and together with earlier invoices on the order it goes over the ceiling'}.`]
        : [];
    case 'EXC-NON_PO': {
      const why = inv.poReference
        ? `The invoice prints purchase order ${inv.poReference}, but no such order is on file for ${inv.vendor}, so it was checked as a non-PO invoice.`
        : 'The invoice refers to no purchase order, so there is no agreed price, quantity or delivery to compare it with.';
      const band = inv.amount <= 100 ? 'up to $100: approved on its own only for a trusted vendor'
        : inv.amount <= 1000 ? '$100.01 to $1,000: a reviewer decides'
        : inv.amount <= 10000 ? '$1,000.01 to $10,000: a reviewer decides, at level 2'
        : 'over $10,000: blocked';
      return [`${why} At ${money(inv.amount, inv.currency)} it falls in the non-PO band ${band}.`];
    }
    case 'EXC-NO_PO':
      return [`The invoice is billed against purchase order ${inv.poReference ?? inv.poNumber}, which is closed or not on file. An order that is missing or closed cannot be billed against.`];
    case 'EXC-CURRENCY':
      return tw && tw.currency !== inv.currency
        ? [`The invoice is in ${inv.currency} but purchase order ${tw.poNumber} is in ${tw.currency}. This system does not convert between currencies.`]
        : [];
    case 'EXC-CREDIT_MEMO':
      return [`This is a credit of ${money(inv.amount, inv.currency)} from ${inv.vendor}: money they owe you. It is larger than what is still open on the invoice it relates to, so a person decides it.`];
    default:
      return [];
  }
}

function bankFacts(inv: CaseLike): string[] {
  const b = inv.bankChange;
  if (!b) return [];
  const accounts = b.oldBankLast4 || b.newBankLast4
    ? `${inv.vendor}'s bank account on file changed${b.oldBankLast4 ? ` from one ending ${b.oldBankLast4}` : ''}${b.newBankLast4 ? ` to one ending ${b.newBankLast4}` : ''}.`
    : `${inv.vendor}'s bank account details changed recently.`;
  const step = {
    start_callback: 'Nobody has phoned the vendor to confirm it yet.',
    record_outcome: 'A callback was started; its outcome has not been recorded yet.',
    second_signoff: 'The vendor confirmed the change by phone; a second person still has to sign off.',
    blocked: 'The vendor did not confirm the change, so payments to them stay blocked.',
  }[b.step] ?? '';
  return [`${accounts} ${step} This is the most common way invoice fraud works: a convincing request to pay a "new" account.`.replace(/\s+/g, ' ').trim()];
}

/** Validate-stage gates that failed, as "duplicate check failed: ...". */
function failedGates(validate: DecisionLike | undefined): string[] {
  return (validate?.claims ?? []).map((c) => /^([a-z_]+): failed - (.+)$/.exec(c)).filter(Boolean).map((m) => `The ${m![1].replace(/_/g, ' ')} check failed: ${m![2]}`);
}

function aiStory(inv: CaseLike, matchAction: string | null, policyAction: string | null): string[] {
  const out: string[] = [];
  const inv1 = last(inv.decisions, (d) => d.nodeId === 'investigate');
  const ver = last(inv.decisions, (d) => d.nodeId === 'verify');
  if (!inv1 && !ver) {
    out.push(inv.state === 'processing' ? 'The AI steps have not run yet.' : 'No AI looked at this invoice: a rule settled it first. Rules always run before any AI, and some findings (a bank change, an unreadable document, a missing order) stop the line on their own.');
    return out;
  }
  if (inv1) {
    if (norm(inv1.actionTaken) === 'error') out.push(`The AI reviewer could not finish: ${inv1.claims[0] ?? 'the step failed'}`);
    else {
      const rec = RECOMMENDS[norm(inv1.actionTaken)] ?? 'in free text instead of one of the system\'s routes';
      out.push(`The AI reviewer${inv1.model ? ` (${inv1.model})` : ''} looked up the vendor's history, duplicates and past corrections, and recommended ${rec}${inv1.confidence != null ? `, reporting itself ${inv1.confidence}% sure` : ''}.`);
      // Free text is not a route the policy step can apply. Since the tool schema constrained it, policy
      // holds such an invoice for a person and says so in its record; before that, the text was not
      // applied at all (older demo records). The text itself is not repeated: it is not something the
      // system did or can do.
      if (!RECOMMENDS[norm(inv1.actionTaken)]) {
        const policy = last(inv.decisions, (d) => d.nodeId === 'policy');
        out.push(policy?.claims.some((c) => c.startsWith('The Investigator\'s recommendation is not one of the actions'))
          ? 'Free text is not a route the system can apply, so the policy step held the invoice for a person rather than guess what it meant.'
          : 'Free text is not a route the system can apply, so it did not change the route: the outcome is the rules\' own.');
      }
    }
  }
  if (ver) {
    const a = norm(ver.actionTaken);
    if (a === 'error') out.push(`The second AI check could not finish: ${(ver.claims[0] ?? '').replace(/^Verifier failed: /, '')}`);
    else if (a === 'disagreement') out.push(`A second AI from a different model family${ver.model ? ` (${ver.model})` : ''} checked it independently and disagreed, so the stricter of the two views stands.`);
    else out.push(`A second AI from a different model family${ver.model ? ` (${ver.model})` : ''} checked it independently and agreed.`);
  }
  // A person's challenge, answered (or not) by the AI steps, and any figures the AI wrote that are not in the records.
  for (const d of [inv1, ver]) {
    for (const c of d?.claims ?? []) {
      if (c.startsWith('Answer to ') || c.includes("'s question was not answered by the AI") || c.startsWith('Figures in this AI explanation')) out.push(c);
    }
  }
  const m = SEVERITY[norm(matchAction)];
  const p = SEVERITY[norm(policyAction)];
  if (inv.reason?.code === 'POLICY_LIMIT') out.push('The rules alone would have approved it. It was held only because of a limit on the Settings page.');
  else if (inv.reason?.code === 'INVESTIGATOR_HOLD') out.push('The rules alone would have approved it. The AI raised a concern the rules did not, so a person looks before any money moves.');
  else if (norm(policyAction) === 'auto_approve') out.push('The rules found nothing wrong and the AI raised no concern the system could act on, so it went through on its own.');
  else if (m != null && p != null && p > m) out.push(`The rules said "${routeFor(matchAction)?.label.toLowerCase()}"; after the AI steps it became "${routeFor(policyAction)?.label.toLowerCase()}". AI can make a decision stricter, never looser.`);
  else if (m != null && p != null) out.push('The outcome is the rules\' own. The AI can only make a decision stricter, never looser, so it cannot approve what the rules flagged.');
  return out;
}

function choiceWords(inv: CaseLike): CaseExplanation['choices'] {
  const a = inv.actions;
  const amount = money(inv.amount, inv.currency);
  const why = (k: 'approve' | 'reject' | 'contest') => (a && !a[k].allowed && a[k].reason ? `Not available now: ${a[k].reason}.` : null);
  const credit = inv.invoiceType === 'credit_memo';
  return {
    approve: why('approve') ?? (inv.bankChange
      ? 'Unlocks only after the bank change is verified by phone and a second person signs off (steps above).'
      : credit
        ? `Posts this credit of ${amount} to the ledger: it lowers what you owe ${inv.vendor}, first on its own invoice if that is still open, then on their next approved invoices. Nothing is paid. Your name goes on the record.`
        : `Posts ${amount} to the ledger as owed to ${inv.vendor}, then pays it, less any approved credit from them not yet used (simulated: no money moves). Your name goes on the record.`),
    reject: why('reject') ?? (credit
      ? `Voids this credit: ${amount} is never posted. Use it if the credit is wrong.`
      : `Voids this invoice: ${amount} is never posted or paid. Use it for an overcharge you will not accept, or a bill nobody ordered.`),
    contest: why('contest') ?? 'Sends it back to the AI with your note, e.g. "the new price was agreed on 3 October". The AI re-reviews with it, but can only make the outcome stricter: it cannot approve what the rules flagged.',
  };
}

export function explainCase(inv: CaseLike): CaseExplanation {
  const machine = inv.decisions.filter((d) => d.nodeId !== 'human_review' && d.nodeId !== 'audit_assemble');
  const match = last(machine, (d) => d.nodeId === 'match');
  const validate = last(machine, (d) => d.nodeId === 'validate');
  const policy = last(machine, (d) => d.nodeId === 'policy');
  const code = inv.reason?.code ?? null;

  const found: string[] = [];
  const notes: string[] = [];
  found.push(...failedGates(validate));
  if (inv.bankChange) found.push(...bankFacts(inv));
  else if (code === 'POLICY_LIMIT') {
    const breach = policy?.claims[policy.claims.length - 1];
    if (breach) notes.push(`${breach.replace(/\.\s*$/, '')}. The invoice itself matched its purchase order and delivery cleanly.`);
  } else if (code === 'INVESTIGATOR_HOLD') {
    if (policy?.claims[0]) notes.push(policy.claims[0]);
  } else if (code === 'R99_AGENT_ERROR') {
    const failed = last(machine, (d) => norm(d.actionTaken) === 'error');
    if (failed?.claims[0]) notes.push(`${failed.claims[0].replace(/^(Investigator|Verifier) failed: /, '')} That is a fault in the automated review, not necessarily in the invoice.`);
  }
  found.push(...notes);
  if (!inv.bankChange) {
    const facts = recordedFacts(match);
    if (facts.length > 0) found.push(...facts);
    else {
      const codes = [...new Set((match?.claims ?? []).map((c) => FINDING_LINE.exec(c.trim())?.[1]).filter((c): c is string => Boolean(c)))];
      for (const c of codes.length ? codes : (code && code.startsWith('EXC-') ? [code] : [])) found.push(...derivedFacts(c, inv));
      const tw = inv.threeWay;
      if (codes.length === 0 && norm(match?.actionTaken) === 'auto_approve' && tw && tw.lines.some((l) => l.invoice)) {
        const n = tw.lines.filter((l) => l.invoice).length;
        found.push(`All ${n} invoice line${n === 1 ? '' : 's'} matched lines on purchase order ${tw.poNumber}: every price is within 2% of the order, nothing is billed beyond what was received in good condition, and no line is outside the order.`);
      }
    }
  }
  if (found.length === 0 && inv.reason) found.push(inv.reason.description);

  const route = inv.state === 'processing' ? null
    : inv.state === 'rejected' ? (inv.summary?.decidedBy && inv.summary.decidedBy !== 'system' ? { label: 'Rejected by a person', meaning: `Rejected by ${inv.summary.decidedBy}: it will not be posted or paid.`, tone: 'bad' as const } : routeFor('auto_reject'))
    : inv.state === 'approved' || inv.state === 'paid'
      ? (inv.summary?.decidedBy && inv.summary.decidedBy !== 'system'
        ? { label: 'Approved by a person', meaning: `${inv.summary.decidedBy} approved it after the checks held it, and it was posted to the ledger.`, tone: 'good' as const }
        : routeFor('auto_approve'))
      : routeFor(policy?.actionTaken) ?? routeFor(match?.actionTaken);

  return { route, found: [...new Set(found)], notes, ai: aiStory(inv, match?.actionTaken ?? null, policy?.actionTaken ?? null), choices: choiceWords(inv) };
}

/** The route an invoice in the queue is waiting on, for a chip on its row ("Blocked", "Reviewer, level 2"). */
export function queueRoute(inv: Pick<CaseLike, 'state' | 'decisions' | 'bankChange'>): Route | null {
  if (inv.state !== 'needs_attention') return null;
  if (inv.bankChange) return ROUTES.block_fraud_flag;
  const policy = last(inv.decisions, (d) => d.nodeId === 'policy');
  return routeFor(policy?.actionTaken);
}
