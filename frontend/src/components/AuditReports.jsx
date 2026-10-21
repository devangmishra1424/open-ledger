import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download } from 'lucide-react';
import { api } from '../services/api';
import { Banner, Spinner } from './ui';
import { formatMoney } from '../lib/labels';

/**
 * The reports an auditor asks for, over a period, from what VeriBook already records (lib/audit/reports.ts):
 * decisions people made against the checks, unpaid invoices by age (tied to the ledger), and goods received but not
 * yet billed. Each row links to its invoice; each report downloads as CSV.
 */
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

const TABS = [
  { key: 'overrides', label: 'Decisions by people', what: 'Every invoice a person approved despite a hold, rejected or challenged: what the checks said, who decided, their note. Flags a decision with no note, and an approval by the person who entered the invoice.' },
  { key: 'ageing', label: 'Unpaid by age', what: "Approved invoices not yet paid, by how long past their due date, with unused vendor credit, checked against the ledger's Accounts Payable total." },
  { key: 'received-not-invoiced', label: 'Received, not billed', what: "Goods accepted by a date that no invoice dated by then has billed, at the PO price: money owed although no bill has arrived (the auditor's year-end cut-off check)." },
];
const KIND_WORDS = { approved_despite_hold: 'Approved despite a hold', approved: 'Approved', rejected: 'Rejected', challenged: 'Challenged' };
const FLAG_WORDS = { no_note: 'no note', approved_own_entry: 'approved own entry' };
const BUCKETS = [['not_due', 'Not due'], ['1-30', '1-30 days'], ['31-60', '31-60'], ['61-90', '61-90'], ['90+', '90+']];

export default function AuditReports() {
  const [tab, setTab] = useState('overrides');
  const [from, setFrom] = useState(daysAgo(90));
  const [to, setTo] = useState(today());
  const [asOf, setAsOf] = useState(today());
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const query = tab === 'overrides' ? { from, to } : { asOf };

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    // Kept with the tab it was fetched for: on a switch, the old tab's data must never be drawn by the new tab's view
    // (the ageing view read the overrides data's missing ledger and the page went blank).
    api.getAuditReport(tab, query).then((d) => !cancelled && setData({ ...d, tab })).catch((e) => !cancelled && setError(e));
    return () => { cancelled = true; };
  }, [tab, from, to, asOf]); // eslint-disable-line react-hooks/exhaustive-deps

  const info = TABS.find((t) => t.key === tab);
  const ready = data && data.tab === tab ? data : null;
  return (
    <section className="vb-card vb-pad vb-audit-reports" aria-labelledby="vb-audit-reports-title">
      <h2 id="vb-audit-reports-title" style={{ marginTop: 0 }}>Reports for the auditor</h2>
      <div className="vb-tabs" role="tablist">
        {TABS.map((t) => <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className="vb-tab" onClick={() => setTab(t.key)}>{t.label}</button>)}
      </div>
      <p className="vb-muted vb-small" style={{ maxWidth: 820, lineHeight: 1.5 }}>{info.what}</p>
      <div className="vb-inline" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {tab === 'overrides' ? (
          <>
            <label className="vb-field"><span>From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="vb-field"><span>To</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          </>
        ) : (
          <label className="vb-field"><span>As of</span><input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
        )}
        <button type="button" className="vb-btn vb-btn-sm" disabled={!ready || ready.rows.length === 0} onClick={() => api.downloadAuditReport(tab, query).catch((e) => setError(e))}><Download size={14} /> Download CSV</button>
      </div>
      {error && <Banner kind="error">{error.message}</Banner>}
      {!ready && !error && <Spinner label="Loading…" />}
      {ready && ready.rows.length === 0 && tab !== 'ageing' && <p className="vb-muted">Nothing in this period.</p>}
      {ready && ready.rows.length > 0 && tab === 'overrides' && <Overrides rows={ready.rows} />}
      {ready && tab === 'ageing' && <Ageing report={ready} />}
      {ready && ready.rows.length > 0 && tab === 'received-not-invoiced' && <NotInvoiced report={ready} />}
    </section>
  );
}

function Overrides({ rows }) {
  return (
    <div className="vb-scroll-x"><table className="vb-table">
      <thead><tr><th>When</th><th>Invoice</th><th className="num">Amount</th><th>Decision</th><th>The checks had said</th><th>By</th><th>Note</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.decisionId}>
          <td>{r.at.slice(0, 10)}</td>
          <td><Link to={`/app/invoice/${r.invoiceId}`}>{r.invoiceNumber}</Link><div className="vb-dim vb-small">{r.vendor}</div></td>
          <td className="num">{formatMoney(r.amount, r.currency)}</td>
          <td>{KIND_WORDS[r.kind]}{r.flags.length > 0 && <div>{r.flags.map((f) => <span key={f} className="vb-chip vb-chip-needs_attention" style={{ marginRight: 4 }}>{FLAG_WORDS[f]}</span>)}</div>}</td>
          <td>{r.checksSaid ?? '—'}</td>
          <td>{r.by}{r.enteredBy && <div className="vb-dim vb-small">entered by {r.enteredBy}</div>}</td>
          <td>{r.note ?? <span className="vb-dim">none</span>}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function Ageing({ report }) {
  const l = report.ledger;
  return (
    <>
      {report.totals.length === 0 && <p className="vb-muted">No approved invoice is waiting to be paid.</p>}
      {report.totals.length > 0 && (
        <div className="vb-scroll-x"><table className="vb-table">
          <thead><tr><th>Currency</th>{BUCKETS.map(([, w]) => <th key={w} className="num">{w}</th>)}<th className="num">Unused credit</th><th className="num">Owed (net)</th></tr></thead>
          <tbody>{report.totals.map((t) => (
            <tr key={t.currency}><td>{t.currency}</td>{BUCKETS.map(([k]) => <td key={k} className="num">{formatMoney(t.buckets[k], t.currency)}</td>)}<td className="num">−{formatMoney(t.unusedCredit, t.currency)}</td><td className="num"><b>{formatMoney(t.net, t.currency)}</b></td></tr>
          ))}</tbody>
        </table></div>
      )}
      <Banner kind={Math.abs(l.difference) < 0.01 ? 'info' : 'warn'}>
        Ledger check: Accounts Payable in the ledger is <b>{l.apBalance.toLocaleString()}</b>; the invoices above net to <b>{l.netOwed.toLocaleString()}</b>.{' '}
        {Math.abs(l.difference) < 0.01 ? 'They agree.' : <>They differ by <b>{l.difference.toLocaleString()}</b>: look for an invoice posted but not listed, or a manual ledger entry.</>}
        {l.note && <div style={{ marginTop: 4 }}>{l.note}</div>}
      </Banner>
      {report.rows.length > 0 && (
        <div className="vb-scroll-x"><table className="vb-table">
          <thead><tr><th>Invoice</th><th>Due</th><th className="num">Days past due</th><th className="num">Still owed</th></tr></thead>
          <tbody>{report.rows.map((r) => (
            <tr key={r.invoiceId}><td><Link to={`/app/invoice/${r.invoiceId}`}>{r.invoiceNumber}</Link><div className="vb-dim vb-small">{r.vendor}</div></td><td>{r.dueDate}</td><td className="num">{r.daysPastDue}</td><td className="num">{formatMoney(r.open, r.currency)}</td></tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}

function NotInvoiced({ report }) {
  return (
    <>
      <p style={{ margin: '8px 0' }}>Owed but not yet billed as of {report.asOf}: {report.totals.map((t) => <b key={t.currency} style={{ marginRight: 10 }}>{formatMoney(t.value, t.currency)}</b>)}</p>
      <div className="vb-scroll-x"><table className="vb-table">
        <thead><tr><th>PO</th><th>Line</th><th className="num">Received</th><th className="num">Billed</th><th className="num">Not billed</th><th className="num">Value</th></tr></thead>
        <tbody>{report.rows.map((r) => (
          <tr key={`${r.poId}-${r.lineNumber}`}><td>{r.poNumber}<div className="vb-dim vb-small">{r.vendor}</div></td><td>{r.lineNumber}. {r.description}</td><td className="num">{r.received}</td><td className="num">{r.invoiced}</td><td className="num"><b>{r.notInvoiced}</b></td><td className="num">{formatMoney(r.value, r.currency)}</td></tr>
        ))}</tbody>
      </table></div>
    </>
  );
}
