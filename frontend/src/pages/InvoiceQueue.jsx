import React, { useState, useEffect } from 'react';
import GlassCard from '../components/GlassCard';
import { api } from '../services/api';
import { Search, Filter, ArrowRight, Lock, CheckCircle2, TriangleAlert, Inbox } from 'lucide-react';
import './InvoiceQueue.css';

const InvoiceQueue = ({ onSelectInvoice }) => {
  const [invoices, setInvoices] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [tab, setTab] = useState('All');

  useEffect(() => {
    let cancelled = false;
    const fetchInvoices = () => api.getInvoices().then((data) => {
      if (!cancelled && data) setInvoices(data);
    });
    fetchInvoices();
    const interval = setInterval(fetchInvoices, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const filtered = invoices.filter((inv) => {
    const matchesSearch = inv.vendor?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          inv.id?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          inv.poNumber?.toLowerCase().includes(searchTerm.toLowerCase());
    if (tab === 'All') return matchesSearch;
    return matchesSearch && inv.status === tab;
  });

  const handleExportCsv = () => {
    if (filtered.length === 0) {
      alert('No invoices in the current view to export.');
      return;
    }
    const headers = ['Invoice ID', 'Vendor', 'PO Number', 'Amount', 'Status', 'Progress %', 'Due Date', 'Risk Flags'];
    const rows = filtered.map((inv) => [
      inv.id, inv.vendor, inv.poNumber, inv.amount, inv.status, inv.progress, inv.dueDate,
      (inv.riskFlags ?? []).join('; '),
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `veribook-invoices-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="invoice-queue-container">
      <GlassCard className="queue-header-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ fontSize: '24px', fontWeight: 700, color: '#ffffff' }}>Invoice Queue</h2>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
              Full accounts payable ledger & agent pipeline progress
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div className="queue-search-box">
              <Search size={14} color="var(--text-muted)" />
              <input 
                type="text" 
                placeholder="Search vendor, ID, PO..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>

            <button className="btn-primary" onClick={handleExportCsv}>
              <span>Export CSV</span>
            </button>
          </div>
        </div>

        {/* Tab Filters */}
        <div className="queue-tabs-row">
          {['All', 'In Review', 'Clean', 'Blocked', 'In Progress'].map((t) => (
            <button
              key={t}
              className={`queue-tab-btn ${tab === t ? 'active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </GlassCard>

      {/* Table List */}
      <GlassCard className="queue-table-card">
        <table className="queue-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Invoice ID</th>
              <th>Vendor</th>
              <th>PO Number</th>
              <th>Amount</th>
              <th>Agent Progress</th>
              <th>Due Date</th>
              <th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ padding: '0' }}>
                  <div style={{ textAlign: 'center', padding: '80px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div style={{ width: '50px', height: '50px', borderRadius: '12px', background: 'rgba(167, 201, 87, 0.1)', border: '1px solid rgba(167, 201, 87, 0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '16px' }}>
                      <Inbox size={24} color="#a7c957" />
                    </div>
                    <h3 style={{ fontSize: '15px', fontWeight: 600, color: '#e5e7eb', marginBottom: '6px' }}>No Invoices Found</h3>
                    <p style={{ color: 'var(--text-muted)', fontSize: '13px', maxWidth: '280px', lineHeight: 1.5 }}>
                      No invoices match the current search or tab filters. Try clearing your search or connecting <code>GET /api/invoices</code>.
                    </p>
                  </div>
                </td>
              </tr>
            ) : (
              filtered.map((inv) => (
                <tr key={inv.id} className="queue-table-row">
                  <td>
                    <span className={`status-chip ${inv.status === 'Clean' ? 'clean' : inv.status === 'In Review' ? 'review' : inv.status === 'Blocked' ? 'blocked' : 'progress'}`}>
                      <span className="status-dot" />
                      {inv.status}
                    </span>
                  </td>
                  <td className="font-mono" style={{ fontWeight: 600, color: '#ffffff' }}>
                    {inv.id}
                  </td>
                  <td style={{ fontWeight: 600, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '6px', height: '100%' }}>
                    {inv.vendor}
                    {inv.riskFlags?.length > 0 && (
                      <TriangleAlert size={14} color="#d00000" title={`Risk Flag: ${inv.riskFlags[0]}`} />
                    )}
                  </td>
                  <td className="font-mono" style={{ color: 'var(--text-muted)' }}>
                    {inv.poNumber}
                  </td>
                  <td className="font-mono queue-amount-highlight">
                    ${inv.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '130px' }}>
                      <div className="progress-bar-track" style={{ height: '4px' }}>
                        <div className={`progress-bar-fill ${inv.progress < 100 ? 'animated-stripe' : ''}`} style={{ width: `${inv.progress}%` }} />
                      </div>
                      <span className="font-mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        {inv.progress}%
                      </span>
                    </div>
                  </td>
                  <td style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    {inv.dueDate}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button 
                      className="btn-glass"
                      style={{ fontSize: '12px', padding: '4px 10px' }}
                      onClick={() => onSelectInvoice(inv)}
                    >
                      <span>View Swimlane</span>
                      <ArrowRight size={12} />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </GlassCard>
    </div>
  );
};

export default InvoiceQueue;
