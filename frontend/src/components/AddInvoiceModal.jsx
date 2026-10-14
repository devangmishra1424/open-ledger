import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../services/api';
import { useInvoices } from '../state/Invoices';
import { useToasts } from '../state/Toasts';
import { Banner, Spinner } from './ui';
import DocumentIntake from './DocumentIntake';

const today = () => new Date().toISOString().slice(0, 10);

export default function AddInvoiceModal({ onClose }) {
  const [mode, setMode] = useState('document');
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="vb-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className={`vb-modal${mode === 'document' ? ' vb-modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="vb-add-title" style={mode === 'document' ? undefined : { width: 'min(680px, 100%)' }} onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="vb-add-title">Add an invoice</h2>
        <div className="vb-tabs" role="tablist" aria-label="How to add it">
          <button type="button" role="tab" className="vb-tab" aria-selected={mode === 'document'} onClick={() => setMode('document')}>From a document</button>
          <button type="button" role="tab" className="vb-tab" aria-selected={mode === 'manual'} onClick={() => setMode('manual')}>Type it in</button>
        </div>
        {mode === 'document' ? <FromDocumentFile onClose={onClose} /> : <Manual onClose={onClose} />}
      </div>
    </div>
  );
}

function useAfterCreate(onClose) {
  const { patch, refresh } = useInvoices();
  const navigate = useNavigate();
  return (invoice) => {
    patch(invoice);
    refresh();
    onClose();
    navigate(`/app/invoice/${invoice.id}`);
  };
}

/** Read a document (any format) into the form, check it next to the original, save it. */
function FromDocumentFile({ onClose }) {
  const afterCreate = useAfterCreate(onClose);
  const toast = useToasts();
  return (
    <DocumentIntake
      onSaved={(invoice) => {
        const n = invoice.corrections?.length ?? 0;
        toast.success(`Invoice ${invoice.invoiceNumber} saved${n ? ` with ${n} correction${n === 1 ? '' : 's'} recorded` : ''}. Checking it now.`);
        afterCreate(invoice);
      }}
    />
  );
}

function Manual({ onClose }) {
  const afterCreate = useAfterCreate(onClose);
  const toast = useToasts();
  const [vendor, setVendor] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(today());
  const [poNumber, setPoNumber] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [tax, setTax] = useState('');
  const [items, setItems] = useState([{ description: '', qty: '1', rate: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const setItem = (i, patch) => setItems((list) => list.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const subtotal = items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.rate) || 0), 0);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const inv = await api.createInvoice({
        vendor: vendor.trim(),
        invoiceNumber: invoiceNumber.trim() || undefined,
        invoiceDate,
        poNumber: poNumber.trim() || undefined,
        currency,
        tax: tax === '' ? undefined : Number(tax),
        items: items.map((it) => ({ description: it.description.trim(), qty: Number(it.qty), rate: Number(it.rate) })),
      });
      toast.success('Invoice received. Checking it now.');
      afterCreate(inv);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="vb-grid-2">
        <label className="vb-field"><span>Vendor</span><input required value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Acme Corp" /></label>
        <label className="vb-field"><span>Invoice number</span><input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} placeholder="Optional" /></label>
        <label className="vb-field"><span>Invoice date</span><input type="date" required value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} /></label>
        <label className="vb-field"><span>Purchase order (optional)</span><input value={poNumber} onChange={(e) => setPoNumber(e.target.value)} placeholder="PO-2024-1138" /></label>
      </div>

      <div className="vb-field">
        <span>Line items</span>
        {items.map((it, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 80px 110px 36px', gap: 8, marginBottom: 6 }}>
            <input aria-label={`Item ${i + 1} description`} required value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} placeholder="Description" />
            <input aria-label={`Item ${i + 1} quantity`} required type="number" min="0.0001" step="any" value={it.qty} onChange={(e) => setItem(i, { qty: e.target.value })} />
            <input aria-label={`Item ${i + 1} unit price`} required type="number" min="0" step="any" value={it.rate} onChange={(e) => setItem(i, { rate: e.target.value })} placeholder="Unit price" />
            <button type="button" className="vb-btn vb-btn-sm" aria-label={`Remove item ${i + 1}`} disabled={items.length === 1} onClick={() => setItems((l) => l.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
          </div>
        ))}
        <button type="button" className="vb-btn vb-btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setItems((l) => [...l, { description: '', qty: '1', rate: '' }])}><Plus size={14} /> Add a line</button>
      </div>

      <div className="vb-grid-2">
        <label className="vb-field"><span>Tax (optional)</span><input type="number" min="0" step="any" value={tax} onChange={(e) => setTax(e.target.value)} /></label>
        <label className="vb-field"><span>Currency</span><input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} maxLength={3} /></label>
      </div>
      <div className="vb-muted" style={{ fontSize: 14 }}>Total: <strong className="vb-mono" style={{ color: 'var(--vb-text)' }}>{(subtotal + (Number(tax) || 0)).toLocaleString('en-US', { minimumFractionDigits: 2 })} {currency}</strong></div>

      {error && <Banner kind="error">{error}</Banner>}
      <div className="vb-modal-actions">
        <button type="button" className="vb-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="vb-btn vb-btn-primary" disabled={busy}>{busy ? <Spinner label="Saving…" /> : 'Add invoice'}</button>
      </div>
    </form>
  );
}
