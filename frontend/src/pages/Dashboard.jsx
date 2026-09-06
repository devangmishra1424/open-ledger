import React, { useState, useEffect } from 'react';
import GlassCard from '../components/GlassCard';
import SpecularButton from '../components/SpecularButton';
import PixelTransition from '../components/PixelTransition';
import Shuffle from '../components/Shuffle';
import { LedgerSummaryWidget, PendingSealsWidget, ActivityWidget } from '../components/RightPanel';
import { mockInvoices, mockPendingSeals } from '../data/mockData';
import { api } from '../services/api';
import { 
  Plus, 
  Filter, 
  ArrowRight,
  Sparkles,
  Construction
} from 'lucide-react';
import './Dashboard.css';

const Dashboard = ({ onSelectInvoice }) => {
  const [invoices, setInvoices] = useState(mockInvoices);
  const [seals, setSeals] = useState(mockPendingSeals);
  const [allReviewed, setAllReviewed] = useState(false);
  const [statusFilter, setStatusFilter] = useState('All');
  const [priorityFilter, setPriorityFilter] = useState('All');
  const [backlogCount, setBacklogCount] = useState(0);

  useEffect(() => {
    // Fetch live data from backend with automatic mock fallback
    api.getInvoices().then((data) => {
      if (data && data.length > 0) setInvoices(data);
    });
    api.getPendingSeals().then((data) => {
      if (data) setSeals(data);
    });
  }, []);

  useEffect(() => {
    let start = 0;
    const end = invoices.length || 17;
    const duration = 600;
    const stepTime = Math.abs(Math.floor(duration / (end || 1)));
    
    const timer = setInterval(() => {
      start += 1;
      setBacklogCount(start);
      if (start >= end) clearInterval(timer);
    }, stepTime);

    return () => clearInterval(timer);
  }, [invoices]);

  const filteredInvoices = invoices.filter((inv) => {
    if (statusFilter !== 'All' && inv.status !== statusFilter) return false;
    if (priorityFilter !== 'All' && inv.priority !== priorityFilter) return false;
    return true;
  });

  const handleAddNewInvoice = async () => {
    const newId = `INV-2024-0${855 + invoices.length}`;
    const newInv = {
      id: newId,
      vendor: 'Nexus Dynamics',
      vendorLogo: 'ND',
      amount: 15400.00,
      currency: 'USD',
      terms: 'Net 30',
      poNumber: `PO-2024-${1165 + invoices.length}`,
      status: 'In Progress',
      priority: 'High',
      receivedDate: '2026-09-06',
      dueDate: '2026-10-06',
      progress: 25,
      taxId: 'US-88192043',
      confidenceScore: 92.5,
      processedByAgents: ['Format Agent'],
      riskFlags: [],
      hash: '0x38d92a1049581a029e4821a94820194810293847',
      items: [
        { description: 'Cloud Edge Hosting Cluster', qty: 1, rate: 15400.00, amount: 15400.00 }
      ]
    };
    await api.createInvoice(newInv);
    setInvoices([newInv, ...invoices]);
    alert(`Created new Invoice #${newId}! Format Agent initialized.`);
  };

  const handleSealAll = async () => {
    if (seals.length === 0) return;
    await api.sealAllInvoices();
    alert(`Successfully committed cryptographic seal for ${seals.length} invoices! Hash verified on-chain.`);
    setSeals([]);
  };

  const handleMarkReviewed = async () => {
    await api.markAllReviewed();
    setAllReviewed(true);
  };

  const renderStatusIcon = (status) => {
    if (status === 'In Review' || status === 'In Progress') {
      return <Construction size={12} style={{ color: '#ffd60a', marginRight: '3px' }} />;
    }
    return <span className="status-dot" />;
  };

  const getStatusChipClass = (status) => {
    switch (status) {
      case 'Clean': return 'clean';
      case 'In Review': return 'review';
      case 'Blocked': return 'blocked';
      default: return 'review';
    }
  };

  return (
    <div className="dashboard-grid-layout">
      {/* Middle Layout Area: Top Summary Widgets & Invoices Box */}
      <div className="dashboard-middle-column">
        {/* Top Summary Row: Ledger Summary & Pending Seals */}
        <div className="top-summary-grid">
          <LedgerSummaryWidget 
            allReviewed={allReviewed} 
            onMarkReviewed={handleMarkReviewed} 
          />
          <PendingSealsWidget 
            seals={seals} 
            onSealAll={handleSealAll} 
          />
        </div>

        {/* Bottom Middle Area: Filter Options & Add New Invoice + Standard Invoice Scroll List */}
        <GlassCard className="invoices-main-container-card inner-dark-card">
          <div className="dashboard-hero-header">
            <h1 className="hero-headline-compact">
              <Shuffle
                text={`${backlogCount || 17} INVOICES`}
                shuffleDirection="right"
                duration={0.35}
                animationMode="evenodd"
                shuffleTimes={1}
                ease="power3.out"
                stagger={0.03}
                threshold={0.1}
                triggerOnce={true}
                triggerOnHover
                respectReducedMotion={true}
                loop={false}
                loopDelay={0}
              />
              <span className="hero-serif-title">need you</span>
            </h1>

            {/* Filter & Action Bar */}
            <div className="dashboard-filter-bar">
              <div className="filter-inputs-group">
                <select 
                  className="filter-select"
                  value={statusFilter} 
                  onChange={(e) => setStatusFilter(e.target.value)}
                >
                  <option value="All">Status: All</option>
                  <option value="In Review">Status: In Review</option>
                  <option value="Clean">Status: Clean</option>
                  <option value="Blocked">Status: Blocked</option>
                  <option value="In Progress">Status: In Progress</option>
                </select>

                <select 
                  className="filter-select"
                  value={priorityFilter}
                  onChange={(e) => setPriorityFilter(e.target.value)}
                >
                  <option value="All">Priority: All</option>
                  <option value="High">Priority: High</option>
                  <option value="Medium">Priority: Medium</option>
                  <option value="Low">Priority: Low</option>
                </select>

                <button className="btn-glass" title="Toggle Filters" style={{ padding: '6px 11px', fontSize: '12px', fontWeight: 600 }}>
                  <Filter size={13} />
                  <span>Filters</span>
                </button>
              </div>

              <SpecularButton
                size="md"
                radius={16}
                baseColor="#232733"
                lineColor="#ffffff"
                tintOpacity={0}
                onClick={handleAddNewInvoice}
              >
                <Plus size={14} />
                <span style={{ fontWeight: 700, fontSize: '12px' }}>New Invoice</span>
              </SpecularButton>
            </div>
          </div>

          {/* Standard Vertical Invoice Scroll List (Internal Overflow-Y Scroll) */}
          <div className="normal-invoice-scroll-list">
            {filteredInvoices.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)', fontSize: '13.5px' }}>
                No invoices currently in backlog. Click <strong>"+ New Invoice"</strong> above or connect <code>GET /api/invoices</code>.
              </div>
            ) : (
              filteredInvoices.map((inv) => {
                const visibleAgents = inv.processedByAgents.slice(0, 3);
                const extraAgentsCount = inv.processedByAgents.length - visibleAgents.length;

                return (
                  <GlassCard key={inv.id} className="invoice-card-condensed inner-dark-card">
                    {/* Row 1: Title, Status Chip & Amount */}
                    <div className="card-row-top">
                      <div className="card-title-group">
                        <span className={`status-chip ${getStatusChipClass(inv.status)}`} style={{ fontSize: '10.5px', padding: '2px 8px' }}>
                          {renderStatusIcon(inv.status)}
                          {inv.status}
                        </span>
                        <span className="invoice-title-text-compact">
                          Invoice #{inv.id} — {inv.vendor}
                        </span>
                      </div>
                      <div className="invoice-amount-compact font-mono">
                        ${inv.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </div>
                    </div>

                    {/* Row 2: Meta line */}
                    <div className="card-row-meta">
                      <div>
                        <span style={{ fontWeight: 600, color: '#e5e7eb' }}>{inv.terms}</span>
                        <span style={{ margin: '0 6px', color: 'var(--text-dim)' }}>•</span>
                        <span className="font-mono">PO: {inv.poNumber}</span>
                        {inv.riskFlags.length > 0 && (
                          <span style={{ color: '#d00000', marginLeft: '10px', fontSize: '11px', fontWeight: 700 }}>
                            ⚠️ {inv.riskFlags[0]}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                        Received: {inv.receivedDate}
                      </div>
                    </div>

                    {/* Row 3: Progress Track */}
                    <div className="card-row-progress">
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                        <span>Verification Progress</span>
                        <span className="font-mono">{inv.progress}%</span>
                      </div>
                      <div className="progress-bar-track" style={{ height: '5px', background: 'rgba(255, 255, 255, 0.08)', borderRadius: '4px', overflow: 'hidden' }}>
                        <div className="progress-bar-fill" style={{ width: `${inv.progress}%`, height: '100%', background: '#a7c957' }} />
                      </div>
                    </div>

                    {/* Row 4: Agent chips & Action */}
                    <div className="card-row-bottom">
                      <div className="agent-tags-compact">
                        {visibleAgents.map((ag) => (
                          <span key={ag} className="agent-tag-chip-sm">
                            ✓ {ag}
                          </span>
                        ))}
                        {extraAgentsCount > 0 && (
                          <span className="agent-tag-chip-sm" style={{ color: '#a7c957', borderColor: 'rgba(167, 201, 87, 0.3)' }}>
                            +{extraAgentsCount} more
                          </span>
                        )}
                      </div>

                      <button 
                        className="btn-glass"
                        style={{ fontSize: '11.5px', padding: '5px 12px', fontWeight: 600 }}
                        onClick={() => onSelectInvoice(inv)}
                      >
                        <span>View Swimlane</span>
                        <ArrowRight size={12} />
                      </button>
                    </div>
                  </GlassCard>
                );
              })
            )}
          </div>
        </GlassCard>
      </div>

      {/* Right Column: PixelTransition Showcase Card & Activity Logs */}
      <div className="dashboard-right-column">
        {/* Top Right: PixelTransition Showcase Card */}
        <GlassCard className="pixel-card-wrapper inner-dark-card" style={{ padding: '0', overflow: 'hidden' }}>
          <PixelTransition
            firstContent={
              <img 
                src="/meme.jpg" 
                alt="Leonardo DiCaprio Throwing Money Meme" 
                style={{ width: '100%', height: '100%', objectFit: 'cover' }} 
              />
            }
            secondContent={
              <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', backgroundColor: '#090d18', padding: '16px', boxSizing: 'border-box' }}>
                <p style={{ fontWeight: 900, fontSize: '1.35rem', color: '#a7c957', textAlign: 'center', margin: 0, letterSpacing: '-0.5px' }}>
                  Chain Verified ✓
                </p>
              </div>
            }
            gridSize={8}
            pixelColor="#a7c957"
            animationStepDuration={0.4}
            style={{ height: '160px' }}
          />
        </GlassCard>

        {/* Bottom Right: Activity Logs */}
        <ActivityWidget onNavigateToInvoices={() => {}} />
      </div>
    </div>
  );
};

export default Dashboard;
