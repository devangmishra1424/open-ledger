import React, { useState, useEffect } from 'react';
import GlassCard from '../components/GlassCard';
import { mockInvoices } from '../data/mockData';
import { api } from '../services/api';
import { Search, Filter, ArrowRight, Lock, CheckCircle2 } from 'lucide-react';
import './InvoiceQueue.css';

const InvoiceQueue = ({ onSelectInvoice }) => {
  const [invoices, setInvoices] = useState(mockInvoices);
  const [searchTerm, setSearchTerm] = useState('');
  const [tab, setTab] = useState('All');

  useEffect(() => {
    api.getInvoices().then((data) => {
      if (data && data.length > 0) setInvoices(data);
    });
  }, []);

  const filtered = invoices.filter((inv) => {
    const matchesSearch = inv.vendor?.toLowerCase().includes(searchTerm.toLowerCase()) || 
                          inv.id?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          inv.poNumber?.toLowerCase().includes(searchTerm.toLowerCase());
    if (tab === 'All') return matchesSearch;
    return matchesSearch && inv.status === tab;
  });

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

            <button className="btn-primary" onClick={() => alert('Exporting Accounts Payable report CSV...')}>
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
                <td colSpan={8} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)', fontSize: '13px' }}>
                  No invoices found. Connect backend API <code>GET /api/invoices</code> to populate live stream.
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
                  <td style={{ fontWeight: 600, color: '#ffffff' }}>
                    {inv.vendor}
                  </td>
                  <td className="font-mono" style={{ color: 'var(--text-muted)' }}>
                    {inv.poNumber}
                  </td>
                  <td className="font-mono" style={{ fontWeight: 700, color: '#ffffff' }}>
                    ${inv.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '130px' }}>
                      <div className="progress-bar-track" style={{ height: '4px' }}>
                        <div className="progress-bar-fill" style={{ width: `${inv.progress}%` }} />
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
