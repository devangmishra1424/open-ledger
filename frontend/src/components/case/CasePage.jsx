import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { api } from '../../services/api';
import { useInvoices } from '../../state/Invoices';
import { useReviewer } from '../../state/Reviewer';
import { Banner, Empty, Spinner, StateChip } from '../ui';
import Narrative from './Narrative';
import ThreeWayTable from './ThreeWayTable';
import BankChangeSteps from './BankChangeSteps';
import DecisionPanel, { useContestShortcut } from './DecisionPanel';
import Stages, { Integrity } from './Stages';
import AskVoice from './AskVoice';
import { REASON_GUIDE, AUTO_APPROVED_GUIDE } from '../../lib/reasonGuide';
import { formatMoney, timeAgo, actorWords } from '../../lib/labels';

const money2 = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Section({ id, title, sub, children, tone }) {
  return (
    <section className={`vb-sec${tone ? ` vb-sec-${tone}` : ''}`} aria-labelledby={`sec-${id}`}>
      <div className="vb-sec-head">
        <h2 id={`sec-${id}`}>{title}</h2>
        {sub && <p>{sub}</p>}
      </div>
      {children}
    </section>
  );
}

function Guide({ invoice }) {
  const code = invoice.reason?.code;
  const g = code ? REASON_GUIDE[code] : null;
  if (invoice.state === 'approved' || invoice.state === 'paid') {
    if (invoice.summary.decidedBy !== 'system') return null;
    return (
      <div className="vb-guide">
        <h3>Why this went through on its own</h3>
        <p>{AUTO_APPROVED_GUIDE.means}</p>
        <ul>{AUTO_APPROVED_GUIDE.checks.map((c) => <li key={c}>{c}</li>)}</ul>
      </div>
    );
  }
  if (!g) return null;
  return (
    <div className="vb-guide">
      <div className="vb-guide-grid">
        <div>
          <h3>What this means</h3>
          <p>{g.means}</p>
          <h3>Why it matters</h3>
          <p>{g.why}</p>
        </div>
        <div>
          <h3>What to check</h3>
          <ul>{g.check.map((c) => <li key={c}>{c}</li>)}</ul>
          <h3>How these usually end</h3>
          <p>{g.usually}</p>
        </div>
      </div>
      <p className="vb-guide-engine"><b>How the system responds to this on its own:</b> {g.engine}</p>
    </div>
  );
}

export default function CasePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { invoices, error: listError, refresh } = useInvoices();
  const { name, locked, openNameDialog } = useReviewer();
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);

  const live = invoices?.find((i) => i.id === id) ?? null;
  const refetchKey = `${live?.rawStatus}:${live?.decisions?.length}`;

  // The list view is kept fresh by polling; the detail adds the PO comparison and reason names.
  useEffect(() => {
    let alive = true;
    api.getInvoiceById(id)
      .then((d) => { if (alive) { setDetail(d); setDetailError(null); } })
      .catch((e) => { if (alive) setDetailError(e); });
    return () => { alive = false; };
  }, [id, refetchKey]);

  useEffect(() => { window.scrollTo?.(0, 0); document.querySelector('.vb-content')?.scrollTo?.(0, 0); }, [id]);

  const invoice = useMemo(() => {
    if (!live && !detail) return null;
    const base = { ...(detail ?? {}), ...(live ?? {}) };
    base.threeWay = detail ? detail.threeWay : undefined; // undefined = still loading; null = no PO
    base.reasonNames = detail?.reasonNames ?? {};
    return base;
  }, [live, detail]);

  const { retry, busy: retrying } = useContestShortcut(invoice ?? { id });

  if (!invoice) {
    if (detailError?.status === 404 || (invoices && !live && detailError)) {
      return <Empty title="Invoice not found" action={<button type="button" className="vb-btn" onClick={() => navigate('/app')}>Back to the inbox</button>}>It may have been removed, or the link is wrong.</Empty>;
    }
    if (listError && !invoices) return <Banner kind="error" action={<button type="button" className="vb-btn vb-btn-sm" onClick={refresh}>Try again</button>}>Could not load this invoice: {listError.message}</Banner>;
    return <div style={{ padding: 40 }}><Spinner label="Loading the invoice…" /></div>;
  }

  // Previous / next among invoices in the same state: working through a queue without going back.
  const siblings = (invoices ?? []).filter((i) => i.state === invoice.state);
  const pos = siblings.findIndex((i) => i.id === invoice.id);
  const prev = pos > 0 ? siblings[pos - 1] : null;
  const next = pos >= 0 && pos < siblings.length - 1 ? siblings[pos + 1] : null;

  const lastAi = [...invoice.decisions].reverse().find((d) => d.nodeId === 'investigate' || d.nodeId === 'verify');
  const aiFailed = invoice.state === 'needs_attention' && lastAi?.actionTaken === 'error';
  const extract = invoice.decisions.find((d) => d.nodeId === 'extract');
  const itemsTotal = invoice.items.reduce((s, i) => s + i.amount, 0);
  const otherAmount = Math.round((invoice.amount - itemsTotal) * 100) / 100;
  const stateLabel = { needs_attention: 'Needs your attention', processing: 'Being checked', approved: 'Approved', paid: 'Approved and paid', rejected: 'Rejected' }[invoice.state];

  return (
    <article className="vb-case-page">
      {/* ---------- top bar: where you are, and previous / next ---------- */}
      <div className="vb-case-nav">
        <button type="button" className="vb-btn vb-btn-sm" onClick={() => navigate('/app')}><ArrowLeft size={14} /> All invoices</button>
        <div className="vb-case-pager" aria-label="Move through the queue">
          {siblings.length > 1 && <span className="vb-dim vb-small">{pos + 1} of {siblings.length} in &ldquo;{stateLabel}&rdquo;</span>}
          <button type="button" className="vb-btn vb-btn-sm" disabled={!prev} onClick={() => prev && navigate(`/app/invoice/${prev.id}`)} aria-label="Previous invoice"><ChevronLeft size={14} /> Previous</button>
          <button type="button" className="vb-btn vb-btn-sm" disabled={!next} onClick={() => next && navigate(`/app/invoice/${next.id}`)} aria-label="Next invoice">Next <ChevronRight size={14} /></button>
        </div>
      </div>

      {/* ---------- hero ---------- */}
      <header className="vb-hero">
        <div className="vb-hero-main">
          <div className="vb-hero-kicker"><StateChip state={invoice.state} /> <span className="vb-dim">Invoice</span> <span className="vb-mono">{invoice.invoiceNumber}</span></div>
          <h2 className="vb-hero-title">{invoice.vendor}</h2>
          <div className="vb-hero-amount">{formatMoney(invoice.amount, invoice.currency)}</div>
        </div>
        <dl className="vb-facts">
          <div><dt>Purchase order</dt><dd className="vb-mono">{invoice.poNumber}</dd></div>
          <div><dt>Payment terms</dt><dd>{invoice.terms}</dd></div>
          <div><dt>Invoice date</dt><dd>{invoice.invoiceDate}</dd></div>
          <div><dt>Due</dt><dd>{invoice.dueDate}</dd></div>
          <div><dt>Received</dt><dd>{timeAgo(invoice.receivedDate)}</dd></div>
          <div><dt>Tax ID</dt><dd className="vb-mono">{invoice.taxId}</dd></div>
        </dl>
      </header>

      {/* ---------- where it stands: the one thing to read first ---------- */}
      <Section id="stands" title="Where it stands" sub="The short version, then what it means.">
        <div className={`vb-why vb-why-${invoice.state}`}>
          <strong>{invoice.summary.headline}</strong>
          {invoice.summary.detail && <p>{invoice.summary.detail}</p>}
        </div>
        {aiFailed && (
          <div style={{ marginTop: 12 }}>
            <Banner kind="warn" action={
              <button type="button" className="vb-btn vb-btn-sm" disabled={retrying || !invoice.actions.contest.allowed} onClick={retry}>
                {retrying ? <Spinner label="Retrying…" /> : <><RotateCcw size={14} /> Retry AI review</>}
              </button>
            }>
              The {lastAi.nodeId === 'verify' ? 'second AI check' : 'AI review'} did not complete. That is why a person has to look at it; the invoice itself may be fine.
            </Banner>
          </div>
        )}
        <Guide invoice={invoice} />
      </Section>

      <div className="vb-case-grid">
        {/* ---------- sticky column: what you can do ---------- */}
        <aside className="vb-case-aside" aria-label="Decide">
          {invoice.bankChange && (
            <section className="vb-card vb-aside-card vb-aside-alert">
              <h2>Verify the vendor&rsquo;s bank details</h2>
              <BankChangeSteps invoice={invoice} />
            </section>
          )}
          <section className="vb-card vb-aside-card">
            <h2>Your decision</h2>
            <p className="vb-dim vb-small" style={{ margin: '0 0 12px' }}>
              Acting as <b>{name || 'nobody yet'}</b>{locked ? ' (signed in)' : <> &middot; <button type="button" className="vb-link-btn" onClick={openNameDialog}>{name ? 'change' : 'set your name'}</button></>}
            </p>
            <DecisionPanel invoice={invoice} />
          </section>

          <section className="vb-card vb-aside-card">
            <h2>At a glance</h2>
            <dl className="vb-glance">
              <dt>Read by</dt>
              <dd>{extract ? `${actorWords(extract)}${extract.confidence != null ? `, ${extract.confidence}% sure` : ''}` : 'n/a'}</dd>
              <dt>Steps run</dt>
              <dd>{invoice.processedByAgents.length} automatic{invoice.humanActions.length ? `, ${invoice.humanActions.length} by people` : ''}</dd>
              <dt>Flags raised</dt>
              <dd>{invoice.riskFlags.length ? invoice.riskFlags.map((f) => <span key={f} className="vb-tok vb-tok-code" title={invoice.reasonNames[f]}>{f}</span>) : 'None'}</dd>
              <dt>Payment</dt>
              <dd>{invoice.payment ? <>{invoice.payment.reference}{invoice.payment.simulated ? ' (simulated)' : ''}</> : 'Not paid'}</dd>
            </dl>
          </section>
        </aside>

        {/* ---------- main column ---------- */}
        <div className="vb-case-main">
          <Section id="3way" title="Ordered, received, invoiced" sub="The three documents a payment depends on, side by side. This is the same pairing the matching engine works from.">
            {invoice.threeWay === undefined
              ? <div style={{ padding: 20 }}><Spinner label="Loading the purchase order…" /></div>
              : <ThreeWayTable threeWay={invoice.threeWay} invoiceCurrency={invoice.currency} />}
          </Section>

          <Section id="billed" title="What was billed" sub="The lines and totals as they were read from the invoice.">
            <div className="vb-scroll-x">
              <table className="vb-table">
                <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Amount</th></tr></thead>
                <tbody>
                  {invoice.items.map((it, i) => (
                    <tr key={i}><td>{it.description}</td><td className="num">{it.qty}</td><td className="num">{money2(it.rate)}</td><td className="num">{money2(it.amount)}</td></tr>
                  ))}
                  {otherAmount > 0.005 && <tr><td className="vb-muted">Tax and other charges</td><td /><td /><td className="num">{money2(otherAmount)}</td></tr>}
                </tbody>
                <tfoot>
                  <tr><td colSpan={3} style={{ fontWeight: 700, paddingTop: 10 }}>Total due</td><td className="num" style={{ fontWeight: 700, paddingTop: 10 }}>{formatMoney(invoice.amount, invoice.currency)}</td></tr>
                </tfoot>
              </table>
            </div>
          </Section>

          <Section id="ask" title="Ask about this invoice" sub="Type or speak a question in your own words. Answers come only from this invoice's recorded decisions, and nothing here can approve, reject or pay.">
            <AskVoice key={invoice.id} invoice={invoice} />
          </Section>

          <Section id="how" title="How it was decided" sub="Every step, in order: what it is, who did it, what it concluded and why. Ask any step to explain itself.">
            <Stages invoice={invoice} />
          </Section>

          {invoice.humanActions.length > 0 && (
            <Section id="people" title="People who acted" sub="Recorded in the same tamper-evident trail as the automatic steps.">
              <ul className="vb-people">
                {invoice.humanActions.map((h) => (
                  <li key={h.decisionId}>
                    <b>{h.reviewer}</b> {{ approve: 'approved it', reject: 'rejected it', contest: 'challenged it' }[h.action]}
                    <span className="vb-dim"> &middot; {timeAgo(h.at)}</span>
                    {h.note && <blockquote><Narrative text={h.note} reasonNames={invoice.reasonNames} /></blockquote>}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section id="integrity" title="Audit trail integrity" sub="Proof the history above has not been changed.">
            <Integrity invoice={invoice} />
          </Section>
        </div>
      </div>
    </article>
  );
}
