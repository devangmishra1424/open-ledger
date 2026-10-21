import React, { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api } from '../services/api';
import { useToasts } from '../state/Toasts';
import { Banner, Spinner } from '../components/ui';
import { formatMoney } from '../lib/labels';

/** {"INR": 4000000} -> [{ code: 'INR', amount: '4000000' }], in a stable order. */
const rowsOf = (limits) => Object.entries(limits ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([code, amount]) => ({ code, amount: String(amount) }));

export default function SettingsPage() {
  const { system } = useOutletContext() ?? {};
  const toast = useToasts();
  const [saved, setSaved] = useState(null);
  const [confidence, setConfidence] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  /** Limits for currencies other than USD: [{ code, amount }] as typed. */
  const [others, setOthers] = useState([]);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getSettings()
      .then((s) => { setSaved(s); setConfidence(String(s.autoApprovalConfidence)); setMaxAmount(String(s.maxAutoPaymentAmount)); setOthers(rowsOf(s.currencyLimits)); })
      .catch(setError);
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const currencyLimits = Object.fromEntries(others.filter((o) => o.code.trim()).map((o) => [o.code.trim().toUpperCase(), Number(o.amount)]));
      const res = await api.updateSettings({ autoApprovalConfidence: Number(confidence), maxAutoPaymentAmount: Number(maxAmount), currencyLimits });
      setSaved(res);
      setOthers(rowsOf(res.currencyLimits));
      toast.success('Saved. The next invoice is checked against these limits.');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const othersChanged = saved && JSON.stringify(rowsOf(saved.currencyLimits)) !== JSON.stringify(others.filter((o) => o.code.trim()).map((o) => ({ code: o.code.trim().toUpperCase(), amount: String(Number(o.amount)) })));
  const othersValid = others.every((o) => !o.code.trim() || (/^[A-Za-z]{3}$/.test(o.code.trim()) && o.code.trim().toUpperCase() !== 'USD' && Number(o.amount) >= 0 && o.amount !== ''));
  const dirty = saved && othersValid && (Number(confidence) !== saved.autoApprovalConfidence || Number(maxAmount) !== saved.maxAutoPaymentAmount || othersChanged);

  return (
    <div className="vb-page">
      <section className="vb-card vb-pad" aria-labelledby="guardrails">
        <h2 id="guardrails">Auto-approval guardrails</h2>
        <p className="vb-muted" style={{ lineHeight: 1.5, maxWidth: 680 }}>
          An invoice that matches its purchase order and delivery cleanly is approved and paid without a person. These two limits can hold such an invoice back for a human look. They can only make the system more careful; they never approve anything the checks would not.
        </p>
        {error && <Banner kind="error">Could not load settings: {error.message}</Banner>}
        {!saved && !error && <Spinner label="Loading…" />}
        {saved && (
          <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 520 }}>
            <label className="vb-field">
              <span>Largest invoice that can be auto-approved (USD)</span>
              <input type="number" min="0" step="any" required value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)} />
              <span className="vb-field-hint">A USD invoice above {formatMoney(Number(maxAmount) || 0)} goes to a person, however clean it is.</span>
            </label>
            <div className="vb-field">
              <span>The same limit in other currencies</span>
              {others.map((o, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '90px minmax(0, 1fr) 36px', gap: 8 }}>
                  <input aria-label={`Currency ${i + 1}`} value={o.code} maxLength={3} placeholder="INR" onChange={(e) => setOthers((l) => l.map((x, j) => (j === i ? { ...x, code: e.target.value.toUpperCase() } : x)))} />
                  <input aria-label={`Limit ${i + 1}`} type="number" min="0" step="any" value={o.amount} onChange={(e) => setOthers((l) => l.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                  <button type="button" className="vb-btn vb-btn-sm" aria-label={`Remove ${o.code || 'currency'}`} onClick={() => setOthers((l) => l.filter((_, j) => j !== i))}>&times;</button>
                </div>
              ))}
              <button type="button" className="vb-link-btn" style={{ alignSelf: 'flex-start' }} onClick={() => setOthers((l) => [...l, { code: '', amount: '' }])}>+ Add a currency</button>
              <span className="vb-field-hint">There are no exchange rates here, so each currency has its own limit. An invoice in a currency not listed always goes to a person.</span>
            </div>
            <label className="vb-field">
              <span>Minimum AI confidence to auto-approve (%)</span>
              <input type="number" min="0" max="100" step="any" required value={confidence} onChange={(e) => setConfidence(e.target.value)} />
              <span className="vb-field-hint">If the Investigator reports less than {confidence || 0}% sure, a person decides. Models are not well calibrated, so treat this as a coarse safety net.</span>
            </label>
            <div><button type="submit" className="vb-btn vb-btn-primary" disabled={saving || !dirty} title={dirty ? 'Applies to the next invoice checked. Invoices already decided keep the limits they were checked with.' : 'Change a limit first'}>{saving ? <Spinner label="Saving…" /> : 'Save limits'}</button>
              <span className="vb-field-hint" style={{ display: 'block', marginTop: 6 }}>Applies to invoices checked from now on; decided invoices keep the limits they were checked with.</span></div>
          </form>
        )}
      </section>

      <section className="vb-card vb-pad" aria-labelledby="config">
        <h2 id="config">How this system is configured</h2>
        <p className="vb-muted" style={{ lineHeight: 1.5, maxWidth: 680 }}>Read from the running server, so what you see here is what is actually happening.</p>
        {!system ? <Spinner label="Loading…" /> : (
          <dl className="vb-kv">
            <dt>AI provider</dt>
            <dd>{system.llm.configured
              ? <>{system.llm.provider} <div className="vb-dim vb-small">Serves the three AI steps below. If it is down or out of quota, those steps fail and the invoice waits for a person; nothing is guessed.</div></>
              : <span style={{ color: 'var(--vb-danger)' }}>Not configured: documents the template cannot read, and every AI step, will fail</span>}</dd>
            <dt>Reads documents</dt><dd><span className="vb-mono">{system.llm.models.extractor}</span> <div className="vb-dim vb-small">Only when the fixed template parser cannot read a document. Its reading is checked: lines must add up to the totals.</div></dd>
            <dt>Investigates exceptions</dt><dd><span className="vb-mono">{system.llm.models.investigator}</span> <div className="vb-dim vb-small">Looks up vendor history, duplicates and past corrections with real tools, and recommends. It can only make an outcome stricter.</div></dd>
            <dt>Double-checks</dt><dd><span className="vb-mono">{system.llm.models.verifier}</span> <div className="vb-dim vb-small">A different model family on purpose, so the two rarely make the same mistake. Runs only on serious cases (a level 2 review or a block); if it disagrees, the stricter view wins.</div></dd>
            <dt>Payments</dt><dd><strong>{system.paymentRail.mode === 'simulated' ? 'Simulated' : system.paymentRail.mode}</strong>. Payments are recorded and posted to the ledger; no money moves.</dd>
            <dt>Vendor callbacks</dt><dd>Made by a person. No automated call is placed; the person records the answer and a second person signs off.</dd>
            <dt>Sign-in</dt>
            <dd>{system.authentication?.mode === 'accounts'
              ? <><strong>Accounts.</strong> Every request is signed in, and decisions are recorded under the signed-in account, so “a different person must sign off” compares real accounts. Accounts are set by the operator; there is no self-sign-up, and no roles yet (any account can approve).</>
              : <><strong>Off.</strong> VeriBook runs as an open proof of concept: anyone with the link can use it, and reviewer names are self-declared, so “a different person” checks compare typed names. Accounts can be switched on by the operator (VERIBOOK_USERS).</>}</dd>
            <dt>Audit trail</dt>
            <dd>
              <span className="vb-chain"><span className={`vb-dot ${system.chain.valid ? 'vb-dot-ok' : 'vb-dot-bad'}`} />
                {system.chain.valid ? `Intact: ${system.chain.checked} records verified from the first` : `ALTERED at record ${system.chain.brokenAt}`}</span>
            </dd>
          </dl>
        )}
      </section>
    </div>
  );
}
