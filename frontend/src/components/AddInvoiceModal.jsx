import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2, Upload } from 'lucide-react';
import { api } from '../services/api';
import { useInvoices } from '../state/Invoices';
import { useToasts } from '../state/Toasts';
import { Banner, Spinner } from './ui';

const today = () => new Date().toISOString().slice(0, 10);

const sampleText = () => `Northwind Parts Ltd.
INVOICE
Invoice Number: NW-${Math.floor(1000 + Math.random() * 9000)}
Invoice Date: ${today()}

Line Items:
1. Industrial Bearing Set
   Qty: 12
   Unit Price: $145.00
2. Maintenance Kit
   Qty: 4
   Unit Price: $62.50
---
Subtotal: $1,990.00
Tax: $159.20
Total Amount Due: $2,149.20
`;

export default function AddInvoiceModal({ onClose }) {
  const [mode, setMode] = useState('document');
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="vb-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="vb-modal" role="dialog" aria-modal="true" aria-labelledby="vb-add-title" style={{ width: 'min(680px, 100%)' }} onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="vb-add-title">Add an invoice</h2>
        <div className="vb-tabs" role="tablist" aria-label="How to add it">
          <button type="button" role="tab" className="vb-tab" aria-selected={mode === 'document'} onClick={() => setMode('document')}>From a document</button>
          <button type="button" role="tab" className="vb-tab" aria-selected={mode === 'manual'} onClick={() => setMode('manual')}>Type it in</button>
        </div>
        {mode === 'document' ? <FromDocument onClose={onClose} /> : <Manual onClose={onClose} />}
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
    navigate(`/invoice/${invoice.id}`);
  };
}

function FromDocument({ onClose }) {
  const afterCreate = useAfterCreate(onClose);
  const toast = useToasts();
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null);
  const fileRef = useRef(null);

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setFileName(file.name);
    try {
      if (file.name.toLowerCase().endsWith('.pdf')) {
        const dataUrl = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => reject(new Error('Could not read the file.'));
          r.readAsDataURL(file);
        });
        setText(dataUrl); // sent as-is; the server extracts the PDF text
      } else {
        setText(await file.text());
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const inv = await api.ingestInvoice(text);
      toast.success('Invoice received. Checking it now.');
      setCreated(inv);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    const ex = created.extraction;
    return (
      <>
        <Banner kind={ex.confidence >= 0.85 ? 'info' : 'warn'}>
          <strong>Read {ex.method === 'llm' ? 'by AI' : ex.method === 'template' ? 'with the template parser' : 'partially'}, {Math.round(ex.confidence * 100)}% sure.</strong>
          {ex.confidence < 0.85 && ' That is below the 85% bar, so a person will review it before anything is paid.'}
          {ex.fallbackReason && <div style={{ marginTop: 6 }}>{ex.fallbackReason}</div>}
          {ex.uncertainFields.length > 0 && (
            <ul className="vb-claims" style={{ marginTop: 6 }}>{ex.uncertainFields.map((f) => <li key={f}>{f}</li>)}</ul>
          )}
        </Banner>
        <div className="vb-modal-actions">
          <button type="button" className="vb-btn vb-btn-primary" onClick={() => afterCreate(created)}>Open the invoice</button>
        </div>
      </>
    );
  }

  return (
    <>
      <p className="vb-muted" style={{ margin: 0, fontSize: 14 }}>
        Paste the text of an invoice or upload a PDF or text file. It is read automatically; anything it is unsure of is flagged for a person instead of being guessed.
      </p>
      <label className="vb-field">
        <span>Invoice text</span>
        <textarea
          style={{ minHeight: 200, fontFamily: 'var(--vb-mono)', fontSize: 13 }}
          value={text.startsWith('data:application/pdf') ? `(PDF: ${fileName})` : text}
          readOnly={text.startsWith('data:application/pdf')}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste the invoice here…"
        />
      </label>
      <div className="vb-inline">
        <input ref={fileRef} type="file" accept=".pdf,.txt,text/plain,application/pdf" onChange={onFile} hidden />
        <button type="button" className="vb-btn vb-btn-sm" onClick={() => fileRef.current?.click()}><Upload size={14} /> Upload PDF or text</button>
        <button type="button" className="vb-link-btn" onClick={() => { setFileName(''); setText(sampleText()); }}>Use a sample invoice</button>
      </div>
      {error && <Banner kind="error">{error}</Banner>}
      <div className="vb-modal-actions">
        <button type="button" className="vb-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="vb-btn vb-btn-primary" onClick={submit} disabled={busy || !text.trim()}>
          {busy ? <Spinner label="Reading the document…" /> : 'Read and check it'}
        </button>
      </div>
    </>
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
