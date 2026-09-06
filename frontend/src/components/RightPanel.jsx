import React, { useState, useEffect } from 'react';
import GlassCard from './GlassCard';
import SpecularButton from './SpecularButton';
import { 
  Construction, 
  CheckCircle2, 
  FileCheck, 
  TrendingUp, 
  Clock, 
  ArrowRight
} from 'lucide-react';
import { api } from '../services/api';
import './RightPanel.css';

export const LedgerSummaryWidget = ({ allReviewed, onMarkReviewed, summary: propSummary }) => {
  const [summary, setSummary] = useState(propSummary || null);

  useEffect(() => {
    if (propSummary) {
      setSummary(propSummary);
      return;
    }
    // Polls rather than a single one-shot fetch: a single attempt that lands during a slow
    // dev-server route compile, or while this component happens to be mid-remount, silently
    // never updates the UI again — found by watching this widget stay stuck on stale fallback
    // numbers indefinitely on a real page load despite the backend being fully healthy.
    let cancelled = false;
    const fetchSummary = () => api.getDashboardSummary().then((data) => {
      if (!cancelled && data) setSummary(data);
    });
    fetchSummary();
    const interval = setInterval(fetchSummary, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [propSummary]);

  return (
    <GlassCard className="widget-card ledger-summary-widget inner-dark-card">
      <div className="widget-header">
        <span className="widget-title">
          <TrendingUp size={16} color="#a7c957" />
          Ledger Summary
        </span>
        <span className="widget-timestamp">{summary?.lastSync ?? 'Just now'}</span>
      </div>

      <div className="summary-value-box">
        <div className="summary-amount font-mono">
          ${(summary?.totalValue ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
        </div>
        <div className="summary-label">Total Active Pipeline Value</div>
      </div>

      <p className="summary-text-line">
        <strong>{summary?.totalProcessedCount ?? 17} invoices</strong> processed today by autonomous agents. <strong>{summary?.reviewCount ?? 3} flagged</strong> for compliance review.
      </p>

      <button 
        className={`btn-glass ${allReviewed ? 'reviewed-active' : ''}`}
        style={{ width: '100%', justifyContent: 'center', borderColor: allReviewed ? '#a7c957' : undefined }}
        onClick={onMarkReviewed}
      >
        <CheckCircle2 size={15} color={allReviewed ? '#a7c957' : undefined} />
        <span>{allReviewed ? 'All Marked Reviewed ✓' : 'Mark All Reviewed'}</span>
      </button>
    </GlassCard>
  );
};

export const PendingSealsWidget = ({ seals, onSealAll }) => {
  return (
    <GlassCard className="widget-card inner-dark-card">
      <div className="widget-header">
        <span className="widget-title">
          <Construction size={16} color="#ffd60a" />
          Pending Seals
        </span>
        <span className="status-chip review" style={{ fontSize: '11px', padding: '2px 8px' }}>
          {seals.length} Pending
        </span>
      </div>

      <div className="pending-seals-list">
        {seals.length > 0 ? (
          seals.map((item) => (
            <div key={item.id} className="seal-item-row">
              <div className="seal-item-left">
                <div className="lock-icon-box">
                  <Construction size={13} color="#ffd60a" />
                </div>
                <div>
                  <div className="seal-vendor-name">{item.vendor}</div>
                  <div className="seal-id font-mono">{item.id}</div>
                </div>
              </div>
              <div>
                <div className="seal-amount font-mono">
                  ${item.amount.toLocaleString()}
                  <span 
                    className="confidence-dot" 
                    style={{ background: item.confidence > 90 ? '#a7c957' : '#ffd60a' }} 
                    title={`Agent Confidence: ${item.confidence}%`}
                  />
                </div>
              </div>
            </div>
          ))
        ) : (
          <div style={{ textAlign: 'center', padding: '14px', color: '#a7c957', fontSize: '13px' }}>
            ✓ All audit seals committed to blockchain!
          </div>
        )}
      </div>

      <SpecularButton
        size="md"
        radius={18}
        baseColor="#232a35"
        lineColor="#ffffff"
        tintOpacity={0}
        disabled={seals.length === 0}
        onClick={onSealAll}
        style={{ width: '100%' }}
      >
        <FileCheck size={16} />
        <span>Seal All ({seals.length})</span>
      </SpecularButton>
    </GlassCard>
  );
};

export const ActivityWidget = ({ onNavigateToInvoices, summary: propSummary }) => {
  const [summary, setSummary] = useState(propSummary || null);
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  useEffect(() => {
    if (propSummary) {
      setSummary(propSummary);
      return;
    }
    let cancelled = false;
    const fetchSummary = () => api.getDashboardSummary().then((data) => {
      if (!cancelled && data) setSummary(data);
    });
    fetchSummary();
    const interval = setInterval(fetchSummary, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [propSummary]);

  return (
    <GlassCard className="widget-card inner-dark-card">
      <div className="widget-header">
        <span className="widget-title">
          <Clock size={16} color="#a7c957" />
          Activity Logs
        </span>
        <button 
          className="btn-glass" 
          style={{ fontSize: '11px', padding: '4px 10px' }}
          onClick={onNavigateToInvoices}
        >
          <span>View report</span>
          <ArrowRight size={12} />
        </button>
      </div>

      <div className="activity-stat-group">
        <div>
          <div className="activity-sealed-count font-mono">
            {summary?.sealedToday ?? 0}
          </div>
          <div className="summary-label">Invoices Sealed Today</div>
        </div>

        <div className="health-gauge-box">
          <div className="health-circle-ring">
            <span className="health-circle-text">{summary?.pipelineHealth ?? 100}%</span>
          </div>
          <div className="health-label">Pipeline<br />Health</div>
        </div>
      </div>

      {/* Weekly Bar Chart */}
      <div className="mini-bar-chart">
        {(summary?.weeklyVolume ?? [0, 0, 0, 0, 0, 0, 0]).map((val, idx) => {
          const heightPct = val > 0 ? (val / 30) * 100 : 8;
          const isToday = idx === 6;
          return (
            <div key={idx} className="chart-bar-column" title={`${days[idx]}: ${val} invoices`}>
              <div 
                className={`bar-fill ${isToday ? 'active-day' : ''}`} 
                style={{ height: `${heightPct}%` }} 
              />
              <span className="chart-day-label">{days[idx]}</span>
            </div>
          );
        })}
      </div>
    </GlassCard>
  );
};

const RightPanel = ({ onNavigateToInvoices }) => {
  const [seals, setSeals] = useState([]);
  const [allReviewed, setAllReviewed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchSeals = () => api.getPendingSeals().then((data) => {
      if (!cancelled && data) setSeals(data);
    });
    fetchSeals();
    const interval = setInterval(fetchSeals, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const handleSealAll = async () => {
    if (seals.length === 0) return;
    const result = await api.sealAllInvoices();
    if (result?.success) {
      alert(`Chain integrity verified for all ${result.sealedCount} pending invoice(s).`);
      setSeals([]);
    } else {
      alert(`Seal check failed for ${result?.failedIds?.length ?? 'some'} invoice(s) — chain is broken.`);
    }
  };

  const handleMarkReviewed = async () => {
    await api.markAllReviewed();
    setAllReviewed(true);
  };

  return (
    <aside className="right-panel-container">
      <LedgerSummaryWidget allReviewed={allReviewed} onMarkReviewed={handleMarkReviewed} />
      <PendingSealsWidget seals={seals} onSealAll={handleSealAll} />
      <ActivityWidget onNavigateToInvoices={onNavigateToInvoices} />
    </aside>
  );
};

export default RightPanel;
