import React from 'react';
import GlassCard from '../components/GlassCard';
import { Settings, Sliders, Key } from 'lucide-react';

const SettingsPage = () => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', width: '100%' }}>
      <GlassCard style={{ padding: '24px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: 700, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Settings size={24} color="#a7c957" />
          Autonomous Ledger System Settings
        </h2>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
          Configure AI agent confidence thresholds, auto-approval limits, and webhooks
        </p>
      </GlassCard>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '20px' }}>
        <GlassCard style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 700, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Sliders size={18} color="#a7c957" />
            Agent Thresholds
          </h3>

          <div>
            <label style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
              Auto-Approval Confidence Limit (Currently 95.0%)
            </label>
            <input type="range" min="80" max="99" defaultValue="95" style={{ width: '100%', accentColor: '#a7c957' }} />
          </div>

          <div>
            <label style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
              Maximum Auto-Payment Amount ($50,000 USD)
            </label>
            <input type="text" className="filter-select font-mono" defaultValue="$50,000.00" style={{ width: '100%' }} />
          </div>
        </GlassCard>

        <GlassCard style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 700, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Key size={18} color="#a7c957" />
            API & Webhooks
          </h3>

          <div>
            <label style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
              ERP Webhook Endpoint
            </label>
            <input type="text" className="filter-select font-mono" defaultValue="https://api.openledger.io/v2/webhooks/erp" style={{ width: '100%' }} />
          </div>

          <button className="btn-primary" style={{ marginTop: 'auto' }} onClick={() => alert('Settings saved!')}>
            <span>Save Configuration</span>
          </button>
        </GlassCard>
      </div>
    </div>
  );
};

export default SettingsPage;
