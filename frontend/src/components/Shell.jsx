import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Inbox as InboxIcon, ShieldCheck, Activity, SlidersHorizontal, Network, Plus } from 'lucide-react';
import { api } from '../services/api';
import { useInvoices } from '../state/Invoices';
import { useReviewer } from '../state/Reviewer';
import { initials } from './ui';
import AddInvoiceModal from './AddInvoiceModal';

const TITLES = {
  '/': ['Inbox', 'Invoices waiting for a decision, and everything that has been decided'],
  '/audit': ['Audit', 'Auditor requests and the tamper-evident decision trail'],
  '/pipeline': ['Pipeline', 'How each automated step is performing'],
  '/network': ['Network', 'Vendors around the pipeline'],
  '/settings': ['Settings', 'Guardrails and how this system is configured'],
};

export default function Shell() {
  const { counts, error } = useInvoices();
  const { name, openNameDialog } = useReviewer();
  const [adding, setAdding] = useState(false);
  const [system, setSystem] = useState(null);
  const location = useLocation();
  const base = '/' + (location.pathname.split('/')[1] || '');
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
    <div className="vb-app">
      <nav className="vb-side" aria-label="Main">
        <div className="vb-brand"><span className="vb-brand-mark" aria-hidden="true">V</span><span>VeriBook</span></div>
        <div className="vb-nav">
          <NavLink to="/" end className={({ isActive }) => `vb-nav-link ${isActive || location.pathname.startsWith('/invoice') ? 'active' : ''}`}>
            <InboxIcon size={18} /> Inbox
            {counts.needs_attention > 0 && <span className="vb-nav-count" aria-label={`${counts.needs_attention} need attention`}>{counts.needs_attention}</span>}
          </NavLink>
          <NavLink to="/audit" className={({ isActive }) => `vb-nav-link ${isActive ? 'active' : ''}`}><ShieldCheck size={18} /> Audit</NavLink>
          <NavLink to="/pipeline" className={({ isActive }) => `vb-nav-link ${isActive ? 'active' : ''}`}><Activity size={18} /> Pipeline</NavLink>
          <NavLink to="/network" className={({ isActive }) => `vb-nav-link ${isActive ? 'active' : ''}`}><Network size={18} /> Network</NavLink>
          <NavLink to="/settings" className={({ isActive }) => `vb-nav-link ${isActive ? 'active' : ''}`}><SlidersHorizontal size={18} /> Settings</NavLink>
        </div>
        <div className="vb-side-spacer" />
        <div className="vb-side-foot">
          <div className="vb-acting">
            <span className="vb-avatar" aria-hidden="true">{initials(name)}</span>
            <div>
              <div style={{ color: 'var(--vb-text)', fontWeight: 600 }}>{name || 'No name set'}</div>
              <button type="button" className="vb-link-btn" onClick={openNameDialog}>{name ? 'Change name' : 'Set your name'}</button>
            </div>
          </div>
          <div className="vb-chain" title={chain ? `${chain.checked} decisions checked` : 'Could not check'}>
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
          <button type="button" className="vb-btn vb-btn-primary" onClick={() => setAdding(true)}><Plus size={16} /> Add invoice</button>
        </header>
        <main className="vb-content">
          <Outlet context={{ system }} />
        </main>
      </div>
      {adding && <AddInvoiceModal onClose={() => setAdding(false)} />}
    </div>
  );
}
