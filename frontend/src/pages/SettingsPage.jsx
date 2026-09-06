import React, { useState, useEffect } from 'react';
import GlassCard from '../components/GlassCard';
import { Settings, Sliders, Key } from 'lucide-react';
import { api } from '../services/api';

const SettingsPage = () => {
  const [confidence, setConfidence] = useState(95);
  const [maxAmount, setMaxAmount] = useState('50000.00');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);

  useEffect(() => {
    api.getSettings().then((data) => {
      if (!data) return;
      setConfidence(data.autoApprovalConfidence);
      setMaxAmount(String(data.maxAutoPaymentAmount));
      setWebhookUrl(data.erpWebhookUrl ?? '');
    });
  }, []);

  const handleSave = async () => {
    const amount = Number(maxAmount);
    if (Number.isNaN(amount) || amount <= 0) {
      alert('Enter a valid positive maximum auto-payment amount.');
      return;
    }
    setIsSaving(true);
    try {
      const result = await api.updateSettings({
        autoApprovalConfidence: confidence,
        maxAutoPaymentAmount: amount,
        erpWebhookUrl: webhookUrl,
      });
      if (result?.success) {
        setSavedAt(new Date().toLocaleTimeString());
      } else {
        alert('Could not save settings — the backend did not confirm it.');
      }
    } finally {
      setIsSaving(false);
    }
  };

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
              Auto-Approval Confidence Limit (Currently {confidence.toFixed(1)}%)
            </label>
            <input
              type="range" min="80" max="99" value={confidence}
              onChange={(e) => setConfidence(Number(e.target.value))}
              style={{ width: '100%', accentColor: '#a7c957' }}
            />
          </div>

          <div>
            <label style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
              Maximum Auto-Payment Amount (USD)
            </label>
            <input
              type="text" className="filter-select font-mono" style={{ width: '100%' }}
              value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)}
            />
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
            <input
              type="text" className="filter-select font-mono" style={{ width: '100%' }}
              placeholder="https://your-erp.example.com/webhooks/ap"
              value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)}
            />
          </div>

          <button className="btn-primary" style={{ marginTop: 'auto' }} onClick={handleSave} disabled={isSaving}>
            <span>{isSaving ? 'Saving…' : 'Save Configuration'}</span>
          </button>
          {savedAt && <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: 0 }}>Saved at {savedAt}</p>}
        </GlassCard>
      </div>
    </div>
  );
};

export default SettingsPage;
