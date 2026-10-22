import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Inbox as InboxIcon, ShieldCheck, Activity, SlidersHorizontal, Network, Plus, ClipboardList, LogOut, Gauge } from 'lucide-react';
import { api } from '../services/api';
import { useInvoices } from '../state/Invoices';
import { useReviewer } from '../state/Reviewer';
import { useAuth } from '../state/Auth';
import { initials } from './ui';
import AddInvoiceModal from './AddInvoiceModal';

const TITLES = {
  '/': ['Inbox', 'Invoices waiting for a decision, and everything that has been decided'],
  '/invoice': ['Invoice', 'Everything about one invoice, and what you can do about it'],
  '/orders': ['Orders', 'Purchase orders and goods receipts: the documents an invoice is checked against'],
  '/audit': ['Audit', 'Auditor requests and the tamper-evident decision trail'],
  '/pipeline': ['Pipeline', 'How each automated step is performing'],
  '/network': ['Network', 'Vendors around the pipeline'],
  '/quality': ['Quality', 'How well VeriBook is deciding: targets, money safety, each step, and what testing found'],
  '/settings': ['Settings', 'Guardrails and how this system is configured'],
};

export default function Shell() {
  const { counts, error } = useInvoices();
  const { name, locked, openNameDialog } = useReviewer();
  const { user, logout } = useAuth();
  const [adding, setAdding] = useState(false);
  const [system, setSystem] = useState(null);
  const location = useLocation();
  // Paths are /app, /app/orders, /app/invoice/:id ...; the second segment picks the title.
  const base = '/' + (location.pathname.split('/')[2] || '');
  // On an invoice page the menu shrinks to an icon rail: the invoice gets the room.
  const compact = location.pathname.startsWith('/app/invoice');
  const [title, sub] = TITLES[base] ?? TITLES['/'];

  useEffect(() => {
    let alive = true;
    const load = () => api.getSystem().then((s) => alive && setSystem(s)).catch(() => alive && setSystem(null));
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const chain = system?.chain;

  return (
    <div className={`vb-app${compact ? ' vb-app-compact' : ''}`}>
      <nav className="vb-side" aria-label="Main">
        <div className="vb-brand"><span className="vb-brand-mark" aria-hidden="true">V</span><span className="vb-brand-name">VeriBook</span></div>
        <div className="vb-nav">
          <NavLink to="/app" end title="Inbox: every invoice, and the ones waiting on a person" className={({ isActive }) => `vb-nav-link ${isActive || location.pathname.startsWith('/app/invoice') ? 'active' : ''}`}>
            <InboxIcon size={18} /> <span className="vb-nav-label">Inbox</span>
            {counts.needs_attention > 0 && <span className="vb-nav-count" aria-label={`${counts.needs_attention} need attention`}>{counts.needs_attention}</span>}
          </NavLink>
          <NavLink to="/app/orders" title="Orders: the purchase orders and deliveries invoices are matched against" className={({ isActive }) => `vb-nav-link ${isActive ? 'active' : ''}`}><ClipboardList size={18} /> <span className="vb-nav-label">Orders</span></NavLink>
          <NavLink to="/app/audit" title="Audit: auditor evidence requests, and proof the decision trail is untouched" className={({ isActive }) => `vb-nav-link ${isActive ? 'active' : ''}`}><ShieldCheck size={18} /> <span className="vb-nav-label">Audit</span></NavLink>
          <NavLink to="/app/pipeline" title="Pipeline: the seven automatic steps and how each is performing" className={({ isActive }) => `vb-nav-link ${isActive ? 'active' : ''}`}><Activity size={18} /> <span className="vb-nav-label">Pipeline</span></NavLink>
          <NavLink to="/app/network" title="Network: how vendors, the pipeline, payments and the ledger connect" className={({ isActive }) => `vb-nav-link ${isActive ? 'active' : ''}`}><Network size={18} /> <span className="vb-nav-label">Network</span></NavLink>
          <NavLink to="/app/quality" title="Quality: is VeriBook deciding well? Targets, money safety and each step, on real invoices and on the lab cases" className={({ isActive }) => `vb-nav-link ${isActive ? 'active' : ''}`}><Gauge size={18} /> <span className="vb-nav-label">Quality</span></NavLink>
          <NavLink to="/app/settings" title="Settings: the auto-approval limits, and how this system is configured" className={({ isActive }) => `vb-nav-link ${isActive ? 'active' : ''}`}><SlidersHorizontal size={18} /> <span className="vb-nav-label">Settings</span></NavLink>
        </div>
        <div className="vb-side-spacer" />
        <div className="vb-side-foot">
          <div className="vb-acting">
            <span className="vb-avatar" aria-hidden="true">{initials(name)}</span>
            <div>
              <div style={{ color: 'var(--vb-text)', fontWeight: 600 }}>{name || 'No name set'}</div>
              {locked
                ? <button type="button" className="vb-link-btn" onClick={logout}><LogOut size={12} aria-hidden="true" /> Sign out</button>
                : <button type="button" className="vb-link-btn" onClick={openNameDialog} title="Your name is recorded on every decision you make. Sign-in is off in this demo, so the name is self-declared.">{name ? 'Change name' : 'Set your name'}</button>}
            </div>
          </div>
          <div className="vb-chain" title={chain ? `All ${chain.checked} recorded decisions were re-hashed from the first and every link still matches, so no past decision has been edited. Rechecked every minute.` : 'Could not check the decision trail'}>
            <span className={`vb-dot ${chain ? (chain.valid ? 'vb-dot-ok' : 'vb-dot-bad') : ''}`} />
            {chain ? (chain.valid ? 'Audit trail intact' : 'Audit trail altered!') : 'Audit trail: unknown'}
          </div>
        </div>
      </nav>

      <div className="vb-main">
        <header className="vb-top">
          <div>
            <h1>{title}</h1>
            <div className="vb-top-sub">{sub}</div>
          </div>
          <div className="vb-top-spacer" />
          {error && <span className="vb-chip vb-chip-rejected" role="status">Offline: {error.message}</span>}
          <button type="button" className="vb-btn vb-btn-primary" onClick={() => setAdding(true)} title="Upload a PDF or image, paste text, or use a sample. It is read, then checked against its purchase order in a few seconds."><Plus size={16} /> Add invoice</button>
        </header>
        <main className="vb-content">
          <Outlet context={{ system, openAddInvoice: () => setAdding(true) }} />
        </main>
      </div>
      {adding && <AddInvoiceModal onClose={() => setAdding(false)} />}
    </div>
  );
}
