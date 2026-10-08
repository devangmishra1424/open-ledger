import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import { api } from '../services/api';
import { useInvoices } from '../state/Invoices';
import CasePanel from '../components/CasePanel';
import { Banner, Empty } from '../components/ui';
import { formatMoney, timeAgo } from '../lib/labels';

const TABS = [
  { key: 'needs_attention', label: 'Needs attention', test: (i) => i.state === 'needs_attention' },
  { key: 'processing', label: 'Processing', test: (i) => i.state === 'processing' },
  { key: 'done', label: 'Done', test: (i) => i.state === 'approved' || i.state === 'paid' },
  { key: 'rejected', label: 'Rejected', test: (i) => i.state === 'rejected' },
  { key: 'all', label: 'All', test: () => true },
];

export default function Inbox() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { invoices, error, refresh } = useInvoices();
  const [tab, setTab] = useState(null);
  const [query, setQuery] = useState('');
  const [summary, setSummary] = useState(null);
  const [outside, setOutside] = useState(null); // an invoice opened by link that is not in the newest-100 list
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

  const selected = (invoices ?? []).find((i) => i.id === id) ?? (outside?.id === id ? outside : null);
  useEffect(() => {
    if (!id || !invoices || invoices.some((i) => i.id === id) || outside?.id === id) return;
    api.getInvoiceById(id).then(setOutside).catch(() => setOutside(null));
  }, [id, invoices, outside]);

  // A tab you picked that has emptied out (you cleared the last item) falls back to the one with work.
  useEffect(() => { if (tab && invoices && countsByTab[tab] === 0 && tab !== 'all') setTab(null); }, [countsByTab, tab, invoices]);

  const onKeyDown = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const idx = visible.findIndex((i) => i.id === id);
    const next = visible[Math.min(visible.length - 1, Math.max(0, idx + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      navigate(`/invoice/${next.id}`);
      listRef.current?.querySelector(`[data-id="${next.id}"]`)?.focus();
    }
  };

  const waiting = (invoices ?? []).filter((i) => i.state === 'needs_attention' && i.currency === 'USD').reduce((s, i) => s + i.amount, 0);
  const week = summary?.weeklyVolume ?? [];
  const weekMax = Math.max(1, ...week);

  return (
    <>
      <div className="vb-kpis" aria-label="Overview">
        <div className="vb-card vb-kpi vb-kpi-attention">
          <span className="vb-kpi-label">Needs attention</span>
          <span className="vb-kpi-value">{invoices ? countsByTab.needs_attention : '–'}</span>
          <span className="vb-kpi-sub">{invoices ? (waiting > 0 ? `${formatMoney(waiting)} waiting on a person` : 'Nothing waiting on you') : ' '}</span>
        </div>
        <div className="vb-card vb-kpi">
          <span className="vb-kpi-label">Being processed</span>
          <span className="vb-kpi-value">{invoices ? countsByTab.processing : '–'}</span>
          <span className="vb-kpi-sub">Checked automatically, in a few seconds</span>
        </div>
        <div className="vb-card vb-kpi">
          <span className="vb-kpi-label">Handled without a person</span>
          <span className="vb-kpi-value">{summary?.stpRate != null ? `${summary.stpRate}%` : '–'}</span>
          <span className="vb-kpi-sub">{summary?.stpRate != null ? 'of current decisions were auto-approved' : 'No decisions yet'}</span>
        </div>
        <div className="vb-card vb-kpi">
          <span className="vb-kpi-label">Received, last 7 days</span>
          <span className="vb-kpi-value">{week.length ? week.reduce((a, b) => a + b, 0) : '–'}</span>
          <div className="vb-bars" aria-hidden="true">{week.map((n, i) => <span key={i} style={{ height: `${Math.max(8, (n / weekMax) * 100)}%` }} />)}</div>
        </div>
      </div>

      <div className="vb-inbox">
        <section className="vb-inbox-list" aria-label="Invoices">
          <div className="vb-toolbar">
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
            {visible.map((i) => (
              <button key={i.id} type="button" role="listitem" data-id={i.id} className="vb-row" aria-current={i.id === id} onClick={() => navigate(`/invoice/${i.id}`)}>
                <span className={`vb-state-dot vb-state-dot-${i.state}`} title={i.state.replace('_', ' ')} aria-label={i.state.replace('_', ' ')} />
                <span style={{ minWidth: 0 }}>
                  <div className="vb-row-vendor">{i.vendor}</div>
                  <div className="vb-row-sub vb-mono">{i.invoiceNumber}{i.poNumber !== 'Non-PO' ? ` · ${i.poNumber}` : ' · no PO'}</div>
                </span>
                <span className="vb-row-why">{i.summary.headline}</span>
                <span>
                  <div className="vb-row-amount">{formatMoney(i.amount, i.currency)}</div>
                  <div className="vb-row-age">{timeAgo(i.receivedDate)}</div>
                </span>
              </button>
            ))}
          </div>
        </section>

        {selected ? (
          <CasePanel invoice={selected} onClose={() => navigate('/')} />
        ) : id && invoices ? (
          <div className="vb-card vb-case"><Empty title="Invoice not found">It may have been removed, or the link is wrong.</Empty></div>
        ) : (
          <div className="vb-card vb-case vb-case-closed" style={{ minHeight: 240 }}>
            <Empty title="Pick an invoice">See why it is here, what the system checked, and what you can do about it.</Empty>
          </div>
        )}
      </div>
    </>
  );
}
