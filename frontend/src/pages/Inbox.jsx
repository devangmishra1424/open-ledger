import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import { api } from '../services/api';
import { useInvoices } from '../state/Invoices';
import CasePage from '../components/case/CasePage';
import { Banner, Empty } from '../components/ui';
import { formatMoney, timeAgo } from '../lib/labels';
import { queueRoute } from '../lib/caseExplain';

const TABS = [
  { key: 'needs_attention', label: 'Needs attention', test: (i) => i.state === 'needs_attention', help: 'Held by a rule or the AI. Nothing here is paid until a person approves it.' },
  { key: 'processing', label: 'Processing', test: (i) => i.state === 'processing', help: 'The automatic checks are still running; this takes a few seconds.' },
  { key: 'done', label: 'Done', test: (i) => i.state === 'approved' || i.state === 'paid', help: 'Approved and posted to the ledger, either automatically (a clean match) or by a person.' },
  { key: 'rejected', label: 'Rejected', test: (i) => i.state === 'rejected', help: 'Voided by a person or by the rules (for example a duplicate). Never posted or paid.' },
  { key: 'all', label: 'All', test: () => true, help: 'Every invoice, newest first.' },
];

/**
 * A first-time visitor's way in: one invoice for each kind of problem the system catches, so the
 * interesting cases are a click away instead of a hunt through the list. Picked from the real data;
 * a kind with no invoice is simply not offered.
 */
const PICKS = [
  { title: 'An overcharge caught', test: (i) => i.state === 'needs_attention' && i.reason?.code === 'EXC-PRICE_VAR' },
  { title: 'A bank-detail change held as possible fraud', test: (i) => i.state === 'needs_attention' && !!i.bankChange },
  { title: 'A spending ceiling exceeded', test: (i) => i.state === 'needs_attention' && i.reason?.code === 'EXC-BLANKET_EXCEEDED' },
  { title: 'A bill with no purchase order', test: (i) => i.state === 'needs_attention' && i.reason?.code === 'EXC-NON_PO' },
  { title: 'Clean on paper, but the AI was unsure', test: (i) => i.state === 'needs_attention' && (i.reason?.code === 'POLICY_LIMIT' || i.reason?.code === 'INVESTIGATOR_HOLD') },
  { title: 'A clean invoice paid with no person involved', test: (i) => (i.state === 'paid' || i.state === 'approved') && i.summary.decidedBy === 'system' },
];

const ORIENT_KEY = 'vb-orient-dismissed';

function Orientation({ invoices, onOpen }) {
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(ORIENT_KEY) === '1'; } catch { return false; } });
  const picks = useMemo(() => PICKS.map((p) => ({ ...p, invoice: (invoices ?? []).find(p.test) })).filter((p) => p.invoice), [invoices]);
  const hide = (v) => { setHidden(v); try { localStorage.setItem(ORIENT_KEY, v ? '1' : '0'); } catch { /* a blocked storage only means it shows again next visit */ } };

  if (hidden) {
    return <button type="button" className="vb-link-btn vb-orient-reopen" onClick={() => hide(false)}>How VeriBook works, and where to start</button>;
  }
  return (
    <section className="vb-card vb-orient" aria-label="How VeriBook works">
      <div className="vb-orient-main">
        <h2>Every invoice is checked against what was ordered and what arrived, before anything is paid.</h2>
        <ol className="vb-orient-steps">
          <li><b>Rules check it.</b> Each line is compared with its purchase order (the agreed price and quantity) and the goods receipt (what arrived in good condition).</li>
          <li><b>AI looks for what rules miss</b>, but can only make a decision stricter, never approve what the rules flagged.</li>
          <li><b>Clean invoices are paid on their own; anything unusual waits here for a person</b>, with the exact reason. Every step is recorded in a tamper-evident trail.</li>
        </ol>
        <div className="vb-legend" aria-label="Colour key">
          <span><i className="vb-state-dot vb-state-dot-needs_attention" /> waiting on a person</span>
          <span><i className="vb-state-dot vb-state-dot-processing" /> being checked</span>
          <span><i className="vb-state-dot vb-state-dot-paid" /> approved / paid</span>
          <span><i className="vb-state-dot vb-state-dot-rejected" /> rejected</span>
        </div>
      </div>
      {picks.length > 0 && (
        <div className="vb-orient-picks">
          <h3>Start here: open one</h3>
          <ul>
            {picks.map((p) => (
              <li key={p.title}>
                <button type="button" className="vb-pick" onClick={() => onOpen(p.invoice.id)}>
                  <span className="vb-pick-title">{p.title}</span>
                  <span className="vb-pick-sub">{p.invoice.vendor} &middot; {formatMoney(p.invoice.amount, p.invoice.currency)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <button type="button" className="vb-orient-close vb-link-btn" onClick={() => hide(true)} aria-label="Hide this introduction">Hide</button>
    </section>
  );
}

/** The queue. Opening an invoice replaces it with that invoice's full page (components/case/CasePage). */
export default function Inbox() {
  const { id } = useParams();
  if (id) return <CasePage />;
  return <Queue />;
}

function Queue() {
  const navigate = useNavigate();
  const { invoices, error, refresh } = useInvoices();
  const [tab, setTab] = useState(null);
  const [query, setQuery] = useState('');
  const [summary, setSummary] = useState(null);
  const listRef = useRef(null);

  useEffect(() => {
    let alive = true;
    const load = () => api.getDashboardSummary().then((s) => alive && setSummary(s)).catch(() => alive && setSummary(null));
    load();
    const t = setInterval(load, 30000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // The first tab shown is the one with work in it.
  const countsByTab = useMemo(() => Object.fromEntries(TABS.map((t) => [t.key, (invoices ?? []).filter(t.test).length])), [invoices]);
  const activeTab = tab ?? (invoices ? (countsByTab.needs_attention > 0 ? 'needs_attention' : 'all') : 'all');

  const visible = useMemo(() => {
    const test = TABS.find((t) => t.key === activeTab).test;
    const q = query.trim().toLowerCase();
    return (invoices ?? []).filter((i) => test(i) && (!q || `${i.vendor} ${i.invoiceNumber} ${i.poNumber}`.toLowerCase().includes(q)));
  }, [invoices, activeTab, query]);

  // A tab you picked that has emptied out (you cleared the last item) falls back to the one with work.
  useEffect(() => { if (tab && invoices && countsByTab[tab] === 0 && tab !== 'all') setTab(null); }, [countsByTab, tab, invoices]);

  const onKeyDown = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const rows = [...listRef.current.querySelectorAll('[data-id]')];
    const idx = rows.indexOf(document.activeElement);
    rows[Math.min(rows.length - 1, Math.max(0, idx + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  };

  const waiting = (invoices ?? []).filter((i) => i.state === 'needs_attention' && i.currency === 'USD').reduce((s, i) => s + i.amount, 0);
  const week = summary?.weeklyVolume ?? [];
  const weekMax = Math.max(1, ...week);

  const activeHelp = TABS.find((t) => t.key === activeTab)?.help;

  return (
    <>
      <Orientation invoices={invoices} onOpen={(id) => navigate(`/app/invoice/${id}`)} />

      <div className="vb-kpis" aria-label="Overview">
        <div className="vb-card vb-kpi vb-kpi-attention" title="Invoices a rule or the AI held for a person. Money waiting on them is not paid until someone decides.">
          <span className="vb-kpi-label">Needs attention</span>
          <span className="vb-kpi-value">{invoices ? countsByTab.needs_attention : '–'}</span>
          <span className="vb-kpi-sub">{invoices ? (waiting > 0 ? `${formatMoney(waiting)} waiting on a person` : 'Nothing waiting on you') : ' '}</span>
        </div>
        <div className="vb-card vb-kpi" title="Invoices whose automatic checks are running right now.">
          <span className="vb-kpi-label">Being processed</span>
          <span className="vb-kpi-value">{invoices ? countsByTab.processing : '–'}</span>
          <span className="vb-kpi-sub">Checked automatically, in a few seconds</span>
        </div>
        <div className="vb-card vb-kpi" title="Straight-through processing: the share of decided invoices that went through every check with no person needed. Higher means less manual work; the demo data is deliberately full of problems.">
          <span className="vb-kpi-label">Handled without a person</span>
          <span className="vb-kpi-value">{summary?.stpRate != null ? `${summary.stpRate}%` : '–'}</span>
          <span className="vb-kpi-sub">{summary?.stpRate != null ? 'of decided invoices passed every check on their own' : 'No decisions yet'}</span>
        </div>
        <div className="vb-card vb-kpi" title="Invoices received per day over the last 7 days (rightmost bar is today).">
          <span className="vb-kpi-label">Received, last 7 days</span>
          <span className="vb-kpi-value">{week.length ? week.reduce((a, b) => a + b, 0) : '–'}</span>
          <div className="vb-bars" aria-hidden="true">{week.map((n, i) => <span key={i} style={{ height: `${Math.max(8, (n / weekMax) * 100)}%` }} />)}</div>
        </div>
      </div>

      <section aria-label="Invoices">
        <div className="vb-toolbar vb-toolbar-row">
          <div className="vb-tabs" role="tablist" aria-label="Filter invoices">
            {TABS.map((t) => (
              <button key={t.key} type="button" role="tab" className="vb-tab" aria-selected={activeTab === t.key} onClick={() => setTab(t.key)}>
                {t.label}<span className="vb-tab-n">{invoices ? countsByTab[t.key] : ''}</span>
              </button>
            ))}
          </div>
          <label className="vb-search-wrap" style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: 12, color: 'var(--vb-dim)' }} aria-hidden="true" />
            <input className="vb-input vb-search" style={{ paddingLeft: 30 }} type="search" placeholder="Search vendor, number, PO" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search invoices" />
          </label>
        </div>
        {activeHelp && <p className="vb-tab-help">{activeHelp} Open any row to see exactly why, and to decide.</p>}

        {error && !invoices && (
          <Banner kind="error" action={<button type="button" className="vb-btn vb-btn-sm" onClick={refresh}>Try again</button>}>
            Could not load invoices: {error.message}
          </Banner>
        )}

        <div className="vb-rows" role="list" ref={listRef} onKeyDown={onKeyDown}>
          {!invoices && !error && Array.from({ length: 5 }, (_, i) => <div key={i} className="vb-skeleton" aria-hidden="true" />)}
          {invoices && visible.length === 0 && (
            invoices.length === 0
              ? <Empty title="No invoices yet">Add one with the button at the top right. Paste an invoice, upload a PDF, or type it in, and watch it get checked.</Empty>
              : activeTab === 'needs_attention' && !query
                ? <Empty title="You are all caught up">Nothing is waiting for a decision. New exceptions will show up here.</Empty>
                : <Empty title="No invoices match">Try a different tab or clear the search.</Empty>
          )}
          {visible.map((i) => {
            const route = queueRoute(i);
            const stateWord = { needs_attention: 'waiting on a person', processing: 'being checked', approved: 'approved', paid: 'paid', rejected: 'rejected' }[i.state];
            return (
            <button key={i.id} type="button" role="listitem" data-id={i.id} className="vb-row" onClick={() => navigate(`/app/invoice/${i.id}`)} title="Open to see exactly why, and to decide">
              <span className={`vb-state-dot vb-state-dot-${i.state}`} title={stateWord} aria-label={stateWord} />
              <span style={{ minWidth: 0 }}>
                <div className="vb-row-vendor">{i.vendor}</div>
                <div className="vb-row-sub vb-mono">{i.invoiceNumber}{i.poNumber !== 'Non-PO' ? ` · ${i.poNumber}` : ' · no PO'}</div>
              </span>
              <span className="vb-row-why">
                {route && <span className={`vb-route vb-route-sm vb-route-${route.tone}`} title={route.meaning}>{route.label}</span>}
                <b>{i.summary.headline}</b>
                {i.summary.detail && <span className="vb-row-detail">{i.summary.detail}</span>}
              </span>
              <span>
                <div className="vb-row-amount">{formatMoney(i.amount, i.currency)}</div>
                <div className="vb-row-age">{timeAgo(i.receivedDate)}</div>
              </span>
            </button>
            );
          })}
        </div>
      </section>
    </>
  );
}
