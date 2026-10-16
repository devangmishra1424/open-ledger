import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';
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
import SourceDocument from './SourceDocument';
import Recheck from './Recheck';
import Verdict from './Verdict';
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

      {/* ---------- how to read this page, for someone seeing it for the first time ---------- */}
      <nav className="vb-pageguide" aria-label="On this page">
        <span className="vb-dim">On this page:</span>
        {[
          ['stands', '1. The verdict and why'],
          ['3way', '2. Ordered vs received vs billed'],
          ['how', '3. Every step that decided it'],
          ['ask', '4. Ask a question'],
        ].map(([id, label]) => (
          <button key={id} type="button" className="vb-pageguide-link" onClick={() => document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{label}</button>
        ))}
        <span className="vb-dim vb-pageguide-aside">Decide in the panel on the right.</span>
      </nav>

      {/* ---------- where it stands: the one thing to read first ---------- */}
      <Section id="stands" title="Where it stands" sub="The verdict for this invoice, what the checks found on it, what the AI did, and what has to happen next.">
        <Verdict invoice={invoice} aiFailed={aiFailed} lastAi={lastAi} retry={retry} retrying={retrying} />
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
            <p className="vb-small vb-muted" style={{ margin: '0 0 8px' }}>The system routes the invoice; a person makes the call on anything it holds. Each button below says what it would do to this invoice.</p>
            <p className="vb-dim vb-small" style={{ margin: '0 0 12px' }}>
              Acting as <b>{name || 'nobody yet'}</b>{locked ? ' (signed in)' : <> &middot; <button type="button" className="vb-link-btn" onClick={openNameDialog}>{name ? 'change' : 'set your name'}</button></>}
            </p>
            <DecisionPanel invoice={invoice} />
          </section>

          <Recheck key={invoice.id} invoice={invoice} />

          <section className="vb-card vb-aside-card">
            <h2>At a glance</h2>
            <dl className="vb-glance">
              <dt title="Which reader took the fields off the document, and how sure it reported being">Read by</dt>
              <dd>{extract ? `${actorWords(extract)}${extract.confidence != null ? `, ${extract.confidence}% sure` : ''}` : 'n/a'}</dd>
              <dt title="Automatic steps recorded for this invoice, and actions people took">Steps run</dt>
              <dd>{invoice.processedByAgents.length} automatic{invoice.humanActions.length ? `, ${invoice.humanActions.length} by people` : ''}</dd>
              <dt title="Every reason any step raised, not only the one that decided the route">Flags raised</dt>
              <dd>{invoice.riskFlags.length
                ? <ul className="vb-glance-flags">{invoice.riskFlags.map((f) => <li key={f}><span className="vb-tok vb-tok-code">{f}</span> {invoice.reasonNames[f] ?? ''}</li>)}</ul>
                : 'None'}</dd>
              <dt title="The payment reference once paid. Payments here are simulated: no money moves">Payment</dt>
              <dd>{invoice.payment ? <>{invoice.payment.reference}{invoice.payment.simulated ? ' (simulated: no money moved)' : ''}</> : 'Not paid'}</dd>
            </dl>
          </section>
        </aside>

        {/* ---------- main column ---------- */}
        <div className="vb-case-main">
          <Section id="3way" title="Ordered, received, invoiced" sub="The three documents a payment depends on: the purchase order (what was agreed), the goods receipt (what arrived in good condition) and the invoice (what is billed). Highlighted rows are where they disagree. It is the same line pairing the matching engine used.">
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
                  {invoice.taxTotal != null ? (
                    <>
                      {invoice.taxTotal > 0.005 && <tr><td className="vb-muted">Tax</td><td /><td /><td className="num">{money2(invoice.taxTotal)}</td></tr>}
                      {Math.abs(invoice.adjustmentTotal ?? 0) > 0.005 && <tr><td className="vb-muted">Round off / discount</td><td /><td /><td className="num">{money2(invoice.adjustmentTotal)}</td></tr>}
                    </>
                  ) : otherAmount > 0.005 && <tr><td className="vb-muted">Tax and other charges</td><td /><td /><td className="num">{money2(otherAmount)}</td></tr>}
                </tbody>
                <tfoot>
                  <tr><td colSpan={3} style={{ fontWeight: 700, paddingTop: 10 }}>Total due</td><td className="num" style={{ fontWeight: 700, paddingTop: 10 }}>{formatMoney(invoice.amount, invoice.currency)}</td></tr>
                </tfoot>
              </table>
            </div>
          </Section>

          {invoice.sourceDocumentId && (
            <Section id="source" title="Source document" sub="The file this invoice was entered from, how it was read, and the original itself.">
              <SourceDocument documentId={invoice.sourceDocumentId} />
            </Section>
          )}

          <Section id="ask" title="Ask about this invoice" sub="Type or speak a question in your own words. Answers come only from this invoice's recorded decisions, and nothing here can approve, reject or pay.">
            <AskVoice key={invoice.id} invoice={invoice} />
          </Section>

          <Section id="how" title="How it was decided" sub="Every step, in order. Steps marked Rules always give the same answer for the same invoice; steps marked AI recommend, and can only make an outcome stricter. Any step can be asked to explain itself, from the recorded trail only.">
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

          <Section id="integrity" title="Audit trail integrity" sub="Proof the history above has not been changed since it was written: each record is sealed with a hash of the one before it.">
            <Integrity invoice={invoice} />
          </Section>
        </div>
      </div>
    </article>
  );
}
