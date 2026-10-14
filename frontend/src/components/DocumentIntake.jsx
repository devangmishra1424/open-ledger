import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, FileText, Plus, Trash2, Upload, X } from 'lucide-react';
import { api } from '../services/api';
import { useReviewer } from '../state/Reviewer';
import { Banner, Spinner } from './ui';
import '../styles/intake.css';

/**
 * Adding an invoice from a document: pick a file -> it is read (Docling + OCR, then layout rules, then the AI only
 * for what the rules could not read) -> the person checks the filled-in form next to the original and saves it.
 * Nothing is booked until "Save and check": the reading only fills the form, and the form must add up to the total.
 */

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.webp,.docx,.xlsx,.pptx,.html,.htm,.csv,.md,.txt';

export const SAMPLES = [
  { file: 'gst-invoice-phone-photo.jpg', label: 'GST invoice, phone photo', note: 'Tally layout · CGST + SGST · round off' },
  { file: 'us-invoice-bad-scan.pdf', label: 'US invoice, bad scan', note: 'skewed, noisy · sales tax + shipping' },
  { file: 'trader-bill-with-discounts-scan.pdf', label: 'Trader bill, scan', note: 'line discounts · KG quantities' },
  { file: 'igst-invoice.pdf', label: 'IGST invoice, PDF', note: 'per-line tax columns · DD/MM dates' },
  { file: 'uk-vat-invoice.docx', label: 'UK VAT invoice, Word', note: '.docx · no OCR needed' },
];

const KIND_LABEL = {
  digital_pdf: 'Digital PDF (read from its text layer, no OCR needed)',
  scanned_pdf: 'Scanned PDF (read by OCR)',
  image: 'Photo or image (read by OCR)',
  office: 'Word / Excel / PowerPoint file',
  web: 'Web page / CSV / Markdown',
  text: 'Pasted text',
};

export default function DocumentIntake({ onSaved }) {
  const [phase, setPhase] = useState('pick');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [reading, setReading] = useState({ name: '', started: 0 });

  const run = async (name, promise) => {
    setError(null);
    setReading({ name, started: Date.now() });
    setPhase('reading');
    try {
      setResult(await promise);
      setPhase('review');
    } catch (e) {
      setError(e.message);
      setPhase('pick');
    }
  };

  if (phase === 'reading') return <ReadingNow name={reading.name} started={reading.started} />;
  if (phase === 'review' && result) return <Review result={result} onBack={() => { setResult(null); setPhase('pick'); }} onSaved={onSaved} />;
  return (
    <Picker
      error={error}
      onFile={(file) => run(file.name, api.readDocument(file, 'invoice'))}
      onText={(text) => run('pasted text', api.readPastedDocument(text, 'invoice'))}
    />
  );
}

// ------------------------------------------------------------------------------------------------ pick

function Picker({ error, onFile, onText }) {
  const fileRef = useRef(null);
  const [over, setOver] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState('');
  const [loadingSample, setLoadingSample] = useState(null);

  const pickSample = async (sample) => {
    setLoadingSample(sample.file);
    try {
      const res = await fetch(`/samples/${sample.file}`);
      if (!res.ok) throw new Error(`could not load the sample (${res.status})`);
      const blob = await res.blob();
      onFile(new File([blob], sample.file, { type: blob.type }));
    } catch (e) {
      alert(e.message);
    } finally {
      setLoadingSample(null);
    }
  };

  return (
    <div className="vb-intake-pick">
      <p className="vb-muted" style={{ margin: 0, fontSize: 14 }}>
        Any invoice: a PDF, a scan, a phone photo, a Word or Excel file. It is read and the form below it is filled in for you to check; nothing is saved until you do.
      </p>
      <div
        className={`vb-drop${over ? ' is-over' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => fileRef.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}
      >
        <Upload size={26} aria-hidden="true" />
        <strong>Drop an invoice here, or choose a file</strong>
        <span className="vb-muted">PDF (digital or scanned) · JPG / PNG photos · Word · Excel · up to 20 MB, 20 pages</span>
        <input ref={fileRef} type="file" accept={ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f); }} />
      </div>
      {error && <Banner kind="error">{error}</Banner>}

      <div className="vb-samples">
        <span className="vb-muted" style={{ fontSize: 13 }}>Or try one of these (generated test invoices, none seen by the reader before it was built):</span>
        <div className="vb-sample-list">
          {SAMPLES.map((s) => (
            <button key={s.file} type="button" className="vb-sample" onClick={() => pickSample(s)} disabled={loadingSample != null}>
              <FileText size={16} aria-hidden="true" />
              <span><strong>{s.label}</strong><small>{s.note}</small></span>
            </button>
          ))}
        </div>
      </div>

      <details className="vb-tech" open={pasting} onToggle={(e) => setPasting(e.currentTarget.open)}>
        <summary>Paste the invoice text instead</summary>
        <textarea className="vb-input" style={{ minHeight: 140, marginTop: 8, fontFamily: 'var(--vb-mono)', fontSize: 13 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the text of an invoice…" />
        <div className="vb-inline" style={{ marginTop: 8 }}>
          <button type="button" className="vb-btn vb-btn-sm" disabled={!text.trim()} onClick={() => onText(text)}>Read the text</button>
        </div>
      </details>
    </div>
  );
}

function ReadingNow({ name, started }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const s = Math.floor((now - started) / 1000);
  return (
    <div className="vb-intake-reading" role="status" aria-live="polite">
      <Spinner label={`Reading ${name}… ${s}s`} />
      <ol className="vb-reading-steps">
        <li className={s >= 0 ? 'is-on' : ''}>What kind of file is it: a digital PDF, a scan, a photo, a Word or Excel file</li>
        <li className={s >= 1 ? 'is-on' : ''}>Scans and photos: find the page, flatten it, straighten it, even the light, then OCR</li>
        <li className={s >= 3 ? 'is-on' : ''}>Layout: the item table, the labelled fields, the totals</li>
        <li className={s >= 5 ? 'is-on' : ''}>Every line and total checked to add up; the AI reads only what the rules could not</li>
      </ol>
      <p className="vb-muted" style={{ fontSize: 13, margin: 0 }}>A digital PDF takes a few seconds; a scan or photo 5 to 20 seconds a page.</p>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ review

const num = (v) => (v === '' || v == null ? NaN : Number(v));
const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');
const round2 = (n) => Math.round(n * 100) / 100;
/** "2026-10-11" -> "11 Oct 2026": a date input shows the browser's own order (10/11/2026 in a US browser), so the
 *  date is also written out in words, which cannot be read the wrong way round. */
const inWords = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');

function initialForm(s) {
  return {
    vendorName: s.vendor_name ?? '',
    invoiceNumber: s.invoice_number ?? '',
    invoiceDate: s.invoice_date ?? '',
    dueDate: s.due_date ?? '',
    poNumber: s.po_reference ?? '',
    currency: s.currency ?? '',
    lines: (s.line_items?.length ? s.line_items : [{ description: '', quantity: 1, unit_price: '' }]).map((l) => ({ description: l.description, quantity: String(l.quantity), unitPrice: String(l.unit_price) })),
    charges: (s.other_charges ?? []).map((c) => ({ label: c.label, amount: String(c.amount) })),
    taxLines: (s.tax_lines?.length ? s.tax_lines : s.tax ? [{ label: 'Tax', amount: s.tax }] : []).map((t) => ({ label: t.label, amount: String(t.amount) })),
    discount: s.discount ? String(s.discount) : '',
    roundOff: s.round_off ? String(s.round_off) : '',
    total: s.total != null ? String(s.total) : '',
  };
}

/** Which form fields an uncertain-field message is about. */
function flagsFor(uncertain) {
  const out = {};
  const add = (key, msg) => (out[key] ??= []).push(msg);
  for (const u of uncertain) {
    const msg = u.replace(/^[a-z_]+:\s*/, '');
    if (u.startsWith('vendor_name')) add('vendorName', msg);
    else if (u.startsWith('invoice_number')) add('invoiceNumber', msg);
    else if (u.startsWith('invoice_date')) add('invoiceDate', msg);
    else if (u.startsWith('po_reference')) add('poNumber', msg);
    else if (u.startsWith('currency')) add('currency', msg);
    else if (u.startsWith('line_items')) add('lines', msg);
    else if (/^(total|subtotal|tax)/.test(u)) add('totals', msg);
    else add('document', msg.replace(/^document:\s*/, ''));
  }
  return out;
}

function Review({ result, onBack, onSaved }) {
  const x = result.extraction;
  const s = x.submission;
  const { withReviewer } = useReviewer();
  const [form, setForm] = useState(() => initialForm(s));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const flags = useMemo(() => flagsFor(s.uncertain_fields ?? []), [s]);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setRow = (key, i, patch) => setForm((f) => ({ ...f, [key]: f[key].map((r, j) => (j === i ? { ...r, ...patch } : r)) }));

  const items = round2(form.lines.reduce((t, l) => t + (num(l.quantity) || 0) * (num(l.unitPrice) || 0), 0));
  const charges = round2(form.charges.reduce((t, c) => t + (num(c.amount) || 0), 0));
  const tax = round2(form.taxLines.reduce((t, c) => t + (num(c.amount) || 0), 0));
  const discount = num(form.discount) || 0;
  const roundOff = num(form.roundOff) || 0;
  const expected = round2(items + charges + tax - discount + roundOff);
  const total = num(form.total);
  const addsUp = Number.isFinite(total) && Math.abs(expected - total) <= 0.01;

  const books = result.books ?? {};
  const already = result.alreadyUploaded;
  const blockSave = Boolean(already?.invoiceId);
  const linesValid = form.lines.length > 0 && form.lines.every((l) => l.description.trim() && num(l.quantity) > 0 && num(l.unitPrice) >= 0);
  const ready = form.vendorName.trim() && form.invoiceNumber.trim() && /^\d{4}-\d{2}-\d{2}$/.test(form.invoiceDate) && /^[A-Za-z]{3}$/.test(form.currency) && linesValid && addsUp && !blockSave;

  const save = () => withReviewer(async (name) => {
    setBusy(true);
    setError(null);
    try {
      const invoice = {
        vendorName: form.vendorName.trim(), invoiceNumber: form.invoiceNumber.trim(), invoiceDate: form.invoiceDate,
        dueDate: form.dueDate || null, poNumber: form.poNumber.trim() || null, currency: form.currency.trim().toUpperCase(),
        lines: form.lines.map((l) => ({ description: l.description.trim(), quantity: num(l.quantity), unitPrice: num(l.unitPrice) })),
        charges: form.charges.filter((c) => c.label.trim() || c.amount !== '').map((c) => ({ label: c.label.trim() || 'Charge', amount: num(c.amount) })),
        taxLines: form.taxLines.filter((t) => t.label.trim() || t.amount !== '').map((t) => ({ label: t.label.trim() || 'Tax', amount: num(t.amount) })),
        discount, roundOff, total,
      };
      const saved = await api.saveInvoiceFromDocument(result.documentId, name, invoice);
      onSaved(saved);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  });

  const Tag = ({ field }) => {
    const src = x.fieldSources?.[field];
    if (!src) return null;
    const label = src === 'ai' ? 'read by AI' : src === 'rules+ai' ? 'rules + AI agree' : 'read by layout rules';
    return <span className={`vb-src vb-src-${src.replace('+', '-')}`}>{label}</span>;
  };
  const Flag = ({ k }) => (flags[k] ? <span className="vb-flag" role="note"><AlertTriangle size={13} aria-hidden="true" /> {flags[k].join('; ')}</span> : null);
  const passed = (x.checks ?? []).filter((c) => c.passed).length;
  const confident = s.confidence >= 0.85;

  return (
    <div className="vb-review">
      <section className="vb-review-doc" aria-label="The original document">
        <DocumentPreview result={result} />
        <ReadingFacts reading={result.reading} />
      </section>

      <section className="vb-review-form" aria-label="What was read">
        <Banner kind={confident ? 'info' : 'warn'}>
          <div>
            <strong>
              {x.method === 'llm' ? 'Read by the layout rules, with the AI filling what they could not' : x.method === 'template' ? 'Read by the layout rules (no AI needed)' : 'Partly read'}
              {` · ${Math.round(s.confidence * 100)}% sure · ${passed}/${(x.checks ?? []).length} checks passed`}
            </strong>
            <div style={{ marginTop: 4 }}>{confident ? 'Check it against the document, then save.' : 'Fields to check are marked. Everything must add up before it can be saved.'}</div>
            {x.fallbackReason && <div style={{ marginTop: 4 }}>{x.fallbackReason}</div>}
            {flags.document && <ul className="vb-claims" style={{ marginTop: 6 }}>{flags.document.map((d) => <li key={d}>{d}</li>)}</ul>}
          </div>
        </Banner>

        {already?.invoiceId && (
          <Banner kind="error"><strong>This exact file was already uploaded and saved as an invoice.</strong> <Link to={`/app/invoice/${already.invoiceId}`}>Open that invoice</Link> instead of entering it twice.</Banner>
        )}
        {books.duplicateInvoiceId && !already?.invoiceId && (
          <Banner kind="error"><strong>{form.vendorName} already sent invoice {form.invoiceNumber}.</strong> <Link to={`/app/invoice/${books.duplicateInvoiceId}`}>Open it</Link>. Saving it again would be refused (a duplicate payment).</Banner>
        )}
        {books.vendor && !books.vendor.exact && (
          <Banner kind="warn">
            <strong>Is this {books.vendor.name}?</strong> A vendor with the same letters is on file; the document reads “{form.vendorName}”.
            {' '}<button type="button" className="vb-link-btn" onClick={() => set({ vendorName: books.vendor.name })}>Use {books.vendor.name}</button>
          </Banner>
        )}
        {!books.vendor && form.vendorName && <Banner kind="info">New vendor: <strong>{form.vendorName}</strong> will be added with trust tier “new”, which gets extra checks.</Banner>}
        {books.po && !books.po.onFile && (
          <Banner kind="warn"><strong>PO {books.po.number} is not on file,</strong> so this will be checked as a non-PO invoice. To three-way match it, <Link to="/app/orders">add the PO and its goods receipt</Link> first.</Banner>
        )}
        {books.po?.onFile && !books.po.sameVendor && (
          <Banner kind="warn"><strong>PO {books.po.number} belongs to {books.po.vendorName},</strong> not to {form.vendorName}: it will not match.</Banner>
        )}
        {books.po?.onFile && books.po.sameVendor && <Banner kind="info"><Check size={14} aria-hidden="true" /> PO {books.po.number} is on file for this vendor: it will be three-way matched.</Banner>}

        <div className="vb-grid-2">
          <Field label="Vendor (who issued it)" flag={<Flag k="vendorName" />} tag={<Tag field="vendor_name" />}>
            <input value={form.vendorName} onChange={(e) => set({ vendorName: e.target.value })} className={flags.vendorName ? 'is-flagged' : ''} />
          </Field>
          <Field label="Invoice number" flag={<Flag k="invoiceNumber" />} tag={<Tag field="invoice_number" />}>
            <input value={form.invoiceNumber} onChange={(e) => set({ invoiceNumber: e.target.value })} className={flags.invoiceNumber ? 'is-flagged' : ''} />
          </Field>
          <Field label="Invoice date" flag={<Flag k="invoiceDate" />} tag={<Tag field="invoice_date" />}>
            <input type="date" value={form.invoiceDate} onChange={(e) => set({ invoiceDate: e.target.value })} className={flags.invoiceDate ? 'is-flagged' : ''} />
            <span className="vb-field-hint">{inWords(form.invoiceDate)}</span>
          </Field>
          <Field label="Due date (optional)">
            <input type="date" value={form.dueDate} onChange={(e) => set({ dueDate: e.target.value })} />
            <span className="vb-field-hint">{inWords(form.dueDate)}</span>
          </Field>
          <Field label="PO number (optional)" flag={<Flag k="poNumber" />} tag={<Tag field="po_reference" />}>
            <input value={form.poNumber} onChange={(e) => set({ poNumber: e.target.value })} className={flags.poNumber ? 'is-flagged' : ''} />
          </Field>
          <Field label="Currency" flag={<Flag k="currency" />} tag={<Tag field="currency" />}>
            <input value={form.currency} maxLength={3} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} className={flags.currency ? 'is-flagged' : ''} placeholder="INR" />
          </Field>
        </div>

        <div className="vb-field">
          <span>Item lines <Tag field="line_items" /></span>
          <Flag k="lines" />
          <div className={`vb-lines${flags.lines ? ' is-flagged' : ''}`}>
            <div className="vb-lines-head" aria-hidden="true"><span>Description</span><span>Qty</span><span>Unit price</span><span>Amount</span><span /></div>
            {form.lines.map((l, i) => (
              <div className="vb-lines-row" key={i}>
                <input aria-label={`Line ${i + 1} description`} value={l.description} onChange={(e) => setRow('lines', i, { description: e.target.value })} />
                <input aria-label={`Line ${i + 1} quantity`} inputMode="decimal" value={l.quantity} onChange={(e) => setRow('lines', i, { quantity: e.target.value })} />
                <input aria-label={`Line ${i + 1} unit price`} inputMode="decimal" value={l.unitPrice} onChange={(e) => setRow('lines', i, { unitPrice: e.target.value })} />
                <span className="vb-mono vb-line-amount">{fmt((num(l.quantity) || 0) * (num(l.unitPrice) || 0))}</span>
                <button type="button" className="vb-btn vb-btn-sm" aria-label={`Remove line ${i + 1}`} disabled={form.lines.length === 1} onClick={() => set({ lines: form.lines.filter((_, j) => j !== i) })}><Trash2 size={14} /></button>
              </div>
            ))}
            <button type="button" className="vb-btn vb-btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => set({ lines: [...form.lines, { description: '', quantity: '1', unitPrice: '' }] })}><Plus size={14} /> Add a line</button>
          </div>
        </div>

        <div className={`vb-totals${flags.totals ? ' is-flagged' : ''}`}>
          <Flag k="totals" />
          <LabelledAmounts title="Charges (shipping, freight…)" rows={form.charges} onChange={(i, p) => setRow('charges', i, p)} onAdd={() => set({ charges: [...form.charges, { label: '', amount: '' }] })} onRemove={(i) => set({ charges: form.charges.filter((_, j) => j !== i) })} hint="Become invoice lines, so the match sees them as not ordered." />
          <LabelledAmounts title="Taxes" tag={<Tag field="tax" />} rows={form.taxLines} onChange={(i, p) => setRow('taxLines', i, p)} onAdd={() => set({ taxLines: [...form.taxLines, { label: '', amount: '' }] })} onRemove={(i) => set({ taxLines: form.taxLines.filter((_, j) => j !== i) })} />
          <div className="vb-grid-3">
            <Field label="Discount (invoice-level)"><input inputMode="decimal" value={form.discount} onChange={(e) => set({ discount: e.target.value })} placeholder="0.00" /></Field>
            <Field label="Round off (±)"><input inputMode="decimal" value={form.roundOff} onChange={(e) => set({ roundOff: e.target.value })} placeholder="0.00" /></Field>
            <Field label="Total" tag={<Tag field="total" />}><input inputMode="decimal" value={form.total} onChange={(e) => set({ total: e.target.value })} className={!addsUp ? 'is-flagged' : ''} /></Field>
          </div>
          <div className={`vb-sum${addsUp ? ' is-ok' : ' is-off'}`} role="status">
            <span>Items {fmt(items)}</span>
            {charges !== 0 && <span>+ charges {fmt(charges)}</span>}
            <span>+ tax {fmt(tax)}</span>
            {discount !== 0 && <span>− discount {fmt(discount)}</span>}
            {roundOff !== 0 && <span>{roundOff > 0 ? '+' : '−'} round off {fmt(Math.abs(roundOff))}</span>}
            <span>= <strong>{fmt(expected)}</strong></span>
            <strong className="vb-sum-verdict">
              {addsUp ? <><Check size={14} aria-hidden="true" /> equals the total</> : <><X size={14} aria-hidden="true" /> {Number.isFinite(total) ? `is ${fmt(Math.abs(expected - total))} ${expected > total ? 'more' : 'less'} than the total ${fmt(total)}` : 'enter the total'}</>}
            </strong>
          </div>
        </div>

        {error && <Banner kind="error">{error}</Banner>}
        <div className="vb-modal-actions">
          <button type="button" className="vb-btn" onClick={onBack} disabled={busy}>Read another document</button>
          <button type="button" className="vb-btn vb-btn-primary" onClick={save} disabled={busy || !ready} title={!ready ? 'Fill the required fields and make it add up first' : undefined}>
            {busy ? <Spinner label="Saving…" /> : 'Save and check it'}
          </button>
        </div>
      </section>
    </div>
  );
}

function Field({ label, tag, flag, children }) {
  return (
    <label className="vb-field">
      <span className="vb-field-label">{label} {tag}</span>
      {children}
      {flag}
    </label>
  );
}

function LabelledAmounts({ title, tag, rows, onChange, onAdd, onRemove, hint }) {
  return (
    <div className="vb-field">
      <span>{title} {tag}</span>
      {rows.map((r, i) => (
        <div className="vb-amount-row" key={i}>
          <input aria-label={`${title} ${i + 1} label`} value={r.label} onChange={(e) => onChange(i, { label: e.target.value })} placeholder="Label" />
          <input aria-label={`${title} ${i + 1} amount`} inputMode="decimal" value={r.amount} onChange={(e) => onChange(i, { amount: e.target.value })} placeholder="0.00" />
          <button type="button" className="vb-btn vb-btn-sm" aria-label={`Remove ${title} ${i + 1}`} onClick={() => onRemove(i)}><Trash2 size={14} /></button>
        </div>
      ))}
      <button type="button" className="vb-link-btn" style={{ alignSelf: 'flex-start' }} onClick={onAdd}>+ Add</button>
      {hint && <span className="vb-field-hint">{hint}</span>}
    </div>
  );
}

/** The original file, shown as it is (PDF or image); Word/Excel and pasted text show the text as read instead. */
export function DocumentPreview({ result }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(null);
  const type = result.reading.mediaType ?? '';
  const showable = type === 'application/pdf' || /^image\/(png|jpeg|webp|gif|bmp)$/.test(type);

  useEffect(() => {
    if (!showable) return undefined;
    let objectUrl = null;
    let cancelled = false;
    api.getDocumentFile(result.documentId)
      .then(({ blob }) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([blob], { type }));
        setUrl(objectUrl);
      })
      .catch((e) => !cancelled && setFailed(e.message));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [result.documentId, showable, type]);

  if (!showable) {
    return <pre className="vb-doc-text" aria-label="The document's text as read">{result.reading.text || '(no text)'}</pre>;
  }
  if (failed) return <Banner kind="error">Could not show the document: {failed}</Banner>;
  if (!url) return <div className="vb-doc-frame vb-doc-loading"><Spinner label="Loading the document…" /></div>;
  return type === 'application/pdf'
    ? <iframe className="vb-doc-frame" src={url} title={`The original: ${result.reading.filename}`} />
    : <div className="vb-doc-frame vb-doc-image"><img src={url} alt={`The original: ${result.reading.filename}`} /></div>;
}

export function ReadingFacts({ reading }) {
  const steps = (reading.preparation ?? []).flatMap((p) => p.steps.map((st) => (reading.preparation.length > 1 ? `page ${p.page}: ${st}` : st)));
  return (
    <dl className="vb-reading-facts">
      <div><dt>File</dt><dd>{reading.filename}</dd></div>
      <div><dt>What it is</dt><dd>{KIND_LABEL[reading.sourceKind] ?? reading.sourceKind}{reading.pageCount > 1 ? ` · ${reading.pageCount} pages` : ''}</dd></div>
      {reading.ocrUsed && <div><dt>OCR</dt><dd>{reading.ocrConfidence != null ? `${Math.floor(reading.ocrConfidence * 100)}% confident` : 'used'} (RapidOCR via Docling)</dd></div>}
      {steps.length > 0 && <div><dt>Done to the page</dt><dd>{steps.join(' · ')}</dd></div>}
      {reading.timingMs?.total != null && <div><dt>Read in</dt><dd>{(reading.timingMs.total / 1000).toFixed(1)} s</dd></div>}
      {(reading.warnings ?? []).length > 0 && <div><dt>Note</dt><dd>{reading.warnings.join(' ')}</dd></div>}
    </dl>
  );
}
