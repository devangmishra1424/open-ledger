import React, { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Upload } from 'lucide-react';
import { api } from '../services/api';
import { useToasts } from '../state/Toasts';
import { Banner, Spinner } from './ui';

const today = () => new Date().toISOString().slice(0, 10);

const samplePo = () => `PURCHASE ORDER
Vendor: Northwind Parts Ltd.
PO Number: PO-${Math.floor(1000 + Math.random() * 9000)}
Order Date: ${today()}

Line Items:
1. Industrial Bearing Set
   Qty: 12
   Unit Price: $145.00
2. Maintenance Kit
   Qty: 4
   Unit Price: $62.50
`;

/** " 2 invoices that cited it were linked and checked again." for a toast; "" when there were none. */
function recheckedWords(list, waited, happened) {
  if (!list?.length) return '';
  const n = list.length;
  return ` ${n === 1 ? `Invoice ${list[0].invoiceNumber}` : `${n} invoices`} that ${waited} ${n === 1 ? 'was' : 'were'} ${happened}.`;
}

function useEscape(onClose) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

/** Goods received: what the warehouse recorded. `value` is owned by the parent so it can be sent with the PO. */
function ReceiptFields({ lines, value, onChange, allowNone }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const modes = [
    ...(allowNone ? [['none', 'Not received yet']] : []),
    ['full', 'Received in full'],
    ['partial', 'Part of it'],
  ];
  return (
    <fieldset className="vb-field" style={{ border: '1px solid var(--vb-border-soft)', borderRadius: 'var(--vb-radius-sm)', padding: 12, margin: 0 }}>
      <legend style={{ padding: '0 6px' }}>Goods received</legend>
      <div className="vb-tabs" role="radiogroup" aria-label="What was received">
        {modes.map(([key, label]) => (
          <button key={key} type="button" role="radio" aria-checked={value.mode === key} className="vb-tab" aria-selected={value.mode === key} onClick={() => set({ mode: key })}>{label}</button>
        ))}
      </div>
      {value.mode === 'partial' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 90px 110px', gap: 8, alignItems: 'center' }}>
          <span className="vb-dim vb-small">Line</span><span className="vb-dim vb-small">Ordered</span><span className="vb-dim vb-small">Received</span>
          {lines.map((l, i) => (
            <React.Fragment key={i}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.description || `Line ${i + 1}`}</span>
              <span className="vb-mono">{l.qty}</span>
              <input aria-label={`Quantity received for line ${i + 1}`} type="number" min="0" step="any" value={value.qty[i] ?? ''} onChange={(e) => { const qty = [...value.qty]; qty[i] = e.target.value; set({ qty }); }} />
            </React.Fragment>
          ))}
        </div>
      )}
      {value.mode !== 'none' && (
        <>
          <div className="vb-grid-2">
            <label className="vb-field"><span>Received on</span><input type="date" value={value.date} onChange={(e) => set({ date: e.target.value })} /></label>
            <label className="vb-field">
              <span>Condition</span>
              <select value={value.condition} onChange={(e) => set({ condition: e.target.value })}>
                <option value="accepted">Accepted</option>
                <option value="damaged">Damaged</option>
                <option value="rejected">Rejected</option>
              </select>
            </label>
          </div>
          <label className="vb-field"><span>Received by (optional)</span><input value={value.receiver} onChange={(e) => set({ receiver: e.target.value })} placeholder="Warehouse" /></label>
          <span className="vb-field-hint">Only accepted goods count as received. An invoice dated more than 7 days before this date is held.</span>
        </>
      )}
    </fieldset>
  );
}

const newReceipt = (mode) => ({ mode, date: today(), condition: 'accepted', receiver: '', qty: [] });

/** The receipt part of a request, or undefined when nothing was received. Throws a readable Error when partial quantities are unusable. */
function receiptPayload(value, lines) {
  if (value.mode === 'none') return undefined;
  const base = { receiptDate: value.date, condition: value.condition, receiverName: value.receiver.trim() || undefined };
  if (value.mode === 'full') return { ...base, receivedInFull: true };
  const rows = lines.map((_, i) => ({ line: i + 1, qty: Number(value.qty[i]) })).filter((r) => r.qty > 0);
  if (rows.length === 0) throw new Error('Enter the quantity received for at least one line.');
  return { ...base, lines: rows };
}

/** Add a purchase order, optionally with the goods receipt, optionally read from a PO document. */
export function AddPoModal({ onClose, onSaved }) {
  useEscape(onClose);
  const toast = useToasts();
  const fileRef = useRef(null);
  const [doc, setDoc] = useState('');
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState(null);
  const [documentId, setDocumentId] = useState(null);
  const [readFrom, setReadFrom] = useState(null);

  const [vendor, setVendor] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [orderDate, setOrderDate] = useState(today());
  const [currency, setCurrency] = useState('USD');
  const [items, setItems] = useState([{ description: '', qty: '1', rate: '' }]);
  const [receipt, setReceipt] = useState(newReceipt('full'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);

  const setItem = (i, patch) => setItems((list) => list.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const total = items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.rate) || 0), 0);

  /** Any PO document (PDF, scan, photo, Word, Excel) or pasted text, read by the document reader into the form. */
  const fill = async (promise) => {
    setReading(true);
    setError(null);
    setReadNote(null);
    try {
      const r = await promise;
      const d = r.extraction;
      setDocumentId(r.alreadyUploaded?.purchaseOrderId ? null : r.documentId);
      setReadFrom(r.reading);
      if (d.vendorName) setVendor(r.books?.vendor && !r.books.vendor.exact ? d.vendorName : (r.books?.vendor?.name ?? d.vendorName));
      if (d.poNumber) setPoNumber(d.poNumber);
      if (d.orderDate) setOrderDate(d.orderDate);
      if (d.currency) setCurrency(d.currency);
      if (d.lines.length > 0) setItems(d.lines.map((l) => ({ description: l.description, qty: String(l.quantity), rate: String(l.unitPrice) })));
      const notes = [];
      if (r.alreadyUploaded?.purchaseOrderId) notes.push('This exact file was already saved as a purchase order.');
      if (r.books?.existingPoId) notes.push(`A purchase order numbered ${d.poNumber} is already on file; saving would be refused.`);
      if (r.books?.vendor && !r.books.vendor.exact) notes.push(`The document reads “${d.vendorName}”; a vendor “${r.books.vendor.name}” with the same letters is on file. Check which is right.`);
      notes.push(...d.missing.map((m) => `Could not read ${m}.`.replace('Could not read this was', 'This was')));
      setReadNote(notes.length === 0
        ? { kind: 'info', text: `Read from ${r.reading.filename}. Check every field below before saving.` }
        : { kind: 'warn', text: notes.join(' ') });
    } catch (err) {
      setError(err.message);
    } finally {
      setReading(false);
    }
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.name.toLowerCase().endsWith('.txt')) {
      setDoc(await file.text());
      return;
    }
    fill(api.readDocument(file, 'purchase_order'));
  };

  const readDocument = () => fill(api.readPastedDocument(doc, 'purchase_order'));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        vendor: vendor.trim(), poNumber: poNumber.trim(), orderDate, currency,
        items: items.map((it) => ({ description: it.description.trim(), qty: Number(it.qty), rate: Number(it.rate) })),
        receipt: receiptPayload(receipt, items),
        sourceDocumentId: documentId ?? undefined,
      };
      const created = await api.createPurchaseOrder(body);
      toast.success(`Purchase order ${created.poNumber} saved.${recheckedWords(created.recheckedInvoices, 'cited it', 'linked and checked again')}`);
      setSaved(created);
      onSaved?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="vb-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="vb-modal" role="dialog" aria-modal="true" aria-labelledby="vb-po-title" style={{ width: 'min(720px, 100%)' }} onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="vb-po-title">Add a purchase order</h2>
        {saved ? (
          <>
            <Banner kind="info">
              <strong>{saved.poNumber} is on file{saved.receiptId ? ', with its goods receipt' : ''}.</strong>
              {saved.recheckedInvoices?.length > 0 ? (
                <div style={{ marginTop: 6 }}>
                  {saved.recheckedInvoices.length === 1 ? 'An invoice' : `${saved.recheckedInvoices.length} invoices`} from this vendor already cited {saved.poNumber}:
                  {' '}{saved.recheckedInvoices.map((i) => i.invoiceNumber).join(', ')}. {saved.recheckedInvoices.length === 1 ? 'It is' : 'They are'} now linked to it and being checked again.
                </div>
              ) : (
                <div style={{ marginTop: 6 }}>Now add the invoice that refers to {saved.poNumber}. Its vendor name should match this one (case and spacing do not matter).</div>
              )}
            </Banner>
            <div className="vb-modal-actions">
              <button type="button" className="vb-btn" onClick={onClose}>Done</button>
              <button type="button" className="vb-btn vb-btn-primary" onClick={() => { onClose(); onSaved?.({ addInvoice: true }); }}>Add the invoice</button>
            </div>
          </>
        ) : (
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <details className="vb-tech" open={!vendor && !poNumber}>
              <summary>Have the PO as a document? Read it in</summary>
              <label className="vb-field" style={{ marginTop: 8 }}>
                <span>PO text</span>
                <textarea
                  style={{ minHeight: 120, fontFamily: 'var(--vb-mono)', fontSize: 13 }}
                  value={doc}
                  onChange={(e) => setDoc(e.target.value)}
                  placeholder="Paste the purchase order here…"
                />
              </label>
              <div className="vb-inline" style={{ marginTop: 8 }}>
                <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.webp,.docx,.xlsx,.pptx,.html,.htm,.csv,.md,.txt" onChange={onFile} hidden />
                <button type="button" className="vb-btn vb-btn-sm" onClick={() => fileRef.current?.click()} disabled={reading}><Upload size={14} /> Upload a PO (PDF, scan, photo, Word, Excel)</button>
                <button type="button" className="vb-btn vb-btn-sm" onClick={readDocument} disabled={reading || !doc.trim()}>{reading ? <Spinner label="Reading…" /> : 'Read it into the form'}</button>
                <button type="button" className="vb-link-btn" onClick={() => setDoc(samplePo())}>Use a sample PO</button>
              </div>
              <div className="vb-field-hint" style={{ marginTop: 6 }}>Read by the same document reader as invoices (OCR for scans and photos). The vendor is taken from the Vendor / Supplier / To block, not your own letterhead. Nothing is saved until you press Save; anything it cannot read, you type.</div>
              {readFrom && <div className="vb-field-hint" style={{ marginTop: 4 }}>Read {readFrom.filename}: {readFrom.ocrUsed ? `OCR ${Math.round((readFrom.ocrConfidence ?? 0) * 100)}% confident` : 'no OCR needed'}{readFrom.timingMs?.total ? `, ${(readFrom.timingMs.total / 1000).toFixed(1)} s` : ''}.</div>}
            </details>
            {readNote && <Banner kind={readNote.kind}>{readNote.text}</Banner>}

            <div className="vb-grid-2">
              <label className="vb-field"><span>Vendor</span><input required value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Acme Corp" /></label>
              <label className="vb-field"><span>PO number</span><input required value={poNumber} onChange={(e) => setPoNumber(e.target.value)} placeholder="PO-2026-1138" /></label>
              <label className="vb-field"><span>Order date</span><input type="date" required value={orderDate} onChange={(e) => setOrderDate(e.target.value)} /></label>
              <label className="vb-field"><span>Currency</span><input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} maxLength={3} /></label>
            </div>

            <div className="vb-field">
              <span>Lines ordered</span>
              {items.map((it, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 80px 110px 36px', gap: 8, marginBottom: 6 }}>
                  <input aria-label={`Line ${i + 1} description`} required value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} placeholder="Description" />
                  <input aria-label={`Line ${i + 1} quantity`} required type="number" min="0.0001" step="any" value={it.qty} onChange={(e) => setItem(i, { qty: e.target.value })} />
                  <input aria-label={`Line ${i + 1} unit price`} required type="number" min="0" step="any" value={it.rate} onChange={(e) => setItem(i, { rate: e.target.value })} placeholder="Unit price" />
                  <button type="button" className="vb-btn vb-btn-sm" aria-label={`Remove line ${i + 1}`} disabled={items.length === 1} onClick={() => setItems((l) => l.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
                </div>
              ))}
              <button type="button" className="vb-btn vb-btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setItems((l) => [...l, { description: '', qty: '1', rate: '' }])}><Plus size={14} /> Add a line</button>
            </div>
            <div className="vb-muted" style={{ fontSize: 14 }}>PO total: <strong className="vb-mono" style={{ color: 'var(--vb-text)' }}>{total.toLocaleString('en-US', { minimumFractionDigits: 2 })} {currency}</strong></div>

            <ReceiptFields lines={items} value={receipt} onChange={setReceipt} allowNone />

            {error && <Banner kind="error">{error}</Banner>}
            <div className="vb-modal-actions">
              <button type="button" className="vb-btn" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="submit" className="vb-btn vb-btn-primary" disabled={busy}>{busy ? <Spinner label="Saving…" /> : 'Save purchase order'}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/** Record goods received against a PO that is already on file (a later or partial delivery). */
export function ReceiptModal({ po, onClose, onSaved }) {
  useEscape(onClose);
  const toast = useToasts();
  const lines = po.lines.map((l) => ({ description: l.description, qty: String(l.ordered) }));
  const [receipt, setReceipt] = useState(newReceipt('full'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const recorded = await api.recordReceipt(po.id, receiptPayload(receipt, lines));
      toast.success(`Goods receipt recorded for ${po.poNumber}.${recheckedWords(recorded.recheckedInvoices, 'was waiting for these goods', 'checked again')}`);
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="vb-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="vb-modal" role="dialog" aria-modal="true" aria-labelledby="vb-rcv-title" onSubmit={submit} onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="vb-rcv-title">Record goods received</h2>
        <div className="vb-muted vb-small">{po.poNumber} &middot; {po.vendor}</div>
        <ReceiptFields lines={lines} value={receipt} onChange={setReceipt} allowNone={false} />
        {error && <Banner kind="error">{error}</Banner>}
        <div className="vb-modal-actions">
          <button type="button" className="vb-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="vb-btn vb-btn-primary" disabled={busy}>{busy ? <Spinner label="Saving…" /> : 'Record receipt'}</button>
        </div>
      </form>
    </div>
  );
}
