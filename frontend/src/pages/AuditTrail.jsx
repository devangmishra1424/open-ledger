import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, ShieldAlert, Plus, Paperclip, FileText, MessageSquareText, RefreshCw, X } from 'lucide-react';
import { api } from '../services/api';
import { useToasts } from '../state/Toasts';
import { Banner, Empty, Spinner } from '../components/ui';
import { actionWords, formatMoney, groundingNote, shortHash, timeAgo } from '../lib/labels';
import { REASON_GUIDE } from '../lib/reasonGuide';
import './AuditTrail.css';

/**
 * Audit support: what an auditor asked for (a "PBC", provided-by-client, request), the invoices behind
 * it with each one's recorded trail, and whether the decision chain as a whole still verifies.
 * Everything shown is read from the server; nothing here is decorative.
 */

const STATUS = {
  open: { label: 'Open', cls: 'vb-chip-needs_attention' },
  in_progress: { label: 'In progress', cls: 'vb-chip-processing' },
  closed: { label: 'Closed', cls: 'vb-chip-neutral' },
};

const REQUEST_TIE_OUT = {
  matched: { label: 'All invoices cleared', cls: 'vb-chip-approved' },
  discrepant: { label: 'Has invoices not cleared', cls: 'vb-chip-rejected' },
  none: { label: 'No invoices linked', cls: 'vb-chip-neutral' },
};

// The tags are VeriBook's own grouping of exception reasons (lib/pbc-shapes.ts), not a control framework.
const TAGS = [
  ['FIN-302', 'Financial accuracy'],
  ['COMP-204', 'PO matching'],
  ['TAX-401', 'Tax'],
  ['DUPL-101', 'Duplicates'],
  ['FRAUD-901', 'Anti-fraud routing'],
  ['AUTH-202', 'Authorization'],
];

/** "Cleared" alone would hide that a person had to step in; the attestations say who did. */
function evidenceOutcome(ev) {
  if (ev.tie_out_status === 'discrepant') return { label: 'Not cleared', cls: 'vb-chip-rejected', tone: 'bad' };
  if ((ev.agent_attestations ?? []).some((a) => a.includes('(person)'))) return { label: 'Cleared by a person', cls: 'vb-chip-processing', tone: 'info' };
  return { label: 'Matched', cls: 'vb-chip-approved', tone: 'ok' };
}

/** "EXC-PRICE_VAR: block" -> the code and action as a label, plus the guide's one-line meaning. */
function discrepancyWords(reason) {
  const m = /^([A-Z][A-Z0-9_-]+):\s*(.+)$/.exec(reason ?? '');
  if (!m) return { label: reason || null, means: null };
  return { label: `${m[1]} · ${actionWords(m[2])}`, means: REASON_GUIDE[m[1]]?.means ?? null };
}

function shortRef(id) {
  return `PBC-${String(id ?? '').slice(0, 6).toUpperCase()}`;
}

export default function AuditTrail() {
  const toast = useToasts();
  const [requests, setRequests] = useState(null);
  const [evidence, setEvidence] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const [chain, setChain] = useState(null); // { valid, checked, brokenAt, at }
  const [verifying, setVerifying] = useState(false);

  const [tieFilter, setTieFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState('all');
  const [minAmount, setMinAmount] = useState(0);

  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  const [confirmingClose, setConfirmingClose] = useState(false);

  const [question, setQuestion] = useState('');
  const [answers, setAnswers] = useState(null);
  const [asking, setAsking] = useState(false);

  const [showNew, setShowNew] = useState(false);
  const [newDescription, setNewDescription] = useState('');
  const [newRequestedBy, setNewRequestedBy] = useState('');
  const [invoices, setInvoices] = useState(null);
  const [picked, setPicked] = useState(() => new Set());

  const loadRequests = useCallback(() => {
    return Promise.all([api.getPbcRequests(), api.getEvidenceRecords()])
      .then(([reqs, ev]) => {
        setRequests(reqs);
        setEvidence(ev);
        setSelectedId((current) => current ?? reqs[0]?.request_id ?? null);
        setLoadError(null);
      })
      .catch((e) => setLoadError(e));
  }, []);

  // Re-hashing the whole chain is the authoritative check, so it runs on arrival and on request, not on a timer.
  const verifyNow = useCallback(() => {
    setVerifying(true);
    api.verifyChain()
      .then((r) => setChain({ ...r, at: new Date().toISOString() }))
      .catch((e) => toast.error(`Could not verify the decision trail: ${e.message}`))
      .finally(() => setVerifying(false));
  }, [toast]);

  useEffect(() => {
    loadRequests();
    verifyNow();
    const t = setInterval(loadRequests, 15000);
    return () => clearInterval(t);
  }, [loadRequests, verifyNow]);

  useEffect(() => {
    setAnswers(null);
    setConfirmingClose(false);
    if (!selectedId) return;
    api.getEvidenceFiles(selectedId).then(setFiles).catch((e) => toast.error(`Could not load attached files: ${e.message}`));
  }, [selectedId, toast]);

  const selected = (requests ?? []).find((r) => r.request_id === selectedId) ?? null;
  const allForSelected = evidence.filter((ev) => ev.request_id === selectedId);
  const shown = allForSelected.filter((ev) => {
    if (tieFilter !== 'all' && ev.tie_out_status !== tieFilter) return false;
    if (tagFilter !== 'all' && !ev.control_objective_tags?.includes(tagFilter)) return false;
    if (minAmount > 0 && ev.amount < minAmount) return false;
    return true;
  });
  const openCount = (requests ?? []).filter((r) => r.status !== 'closed').length;

  const openNewForm = () => {
    setShowNew((v) => !v);
    if (!invoices) api.getInvoices().then(setInvoices).catch((e) => toast.error(`Could not load invoices to link: ${e.message}`));
  };

  const togglePick = (id) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      const result = await api.createPbcRequest({
        description: newDescription.trim(),
        requestedBy: newRequestedBy.trim() || 'Internal Audit',
        itemType: 'invoice_bundle',
        linkedInvoiceIds: [...picked],
      });
      await loadRequests();
      if (result?.id) setSelectedId(result.id);
      setShowNew(false);
      setNewDescription('');
      setNewRequestedBy('');
      setPicked(new Set());
      toast.success('Request created.');
    } catch (err) {
      toast.error(`Could not create the request: ${err.message}`);
    }
  };

  const handleClose = async () => {
    if (!selected) return;
    try {
      await api.closePbcRequest(selected.request_id);
      setRequests((prev) => prev.map((r) => (r.request_id === selected.request_id ? { ...r, status: 'closed' } : r)));
      setConfirmingClose(false);
      toast.success('Request closed.');
    } catch (e) {
      toast.error(`Could not close the request: ${e.message}`);
    }
  };

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !selectedId) return;
    setUploading(true);
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      await api.uploadEvidenceFile(selectedId, file.name, String(dataUrl).split(',')[1] ?? '', file.type);
      setFiles(await api.getEvidenceFiles(selectedId));
      toast.success(`Attached ${file.name}.`);
    } catch (err) {
      toast.error(`Could not attach "${file.name}": ${err.message}`);
    } finally {
      setUploading(false);
    }
  };

  const handleAsk = async (e) => {
    e.preventDefault();
    if (!question.trim() || !selectedId) return;
    setAsking(true);
    setAnswers(null);
    try {
      const res = await api.narratePbcRequest(selectedId, question.trim());
      setAnswers(res.results ?? []);
    } catch (err) {
      toast.error(`The question could not be answered: ${err.message}`);
    } finally {
      setAsking(false);
    }
  };

  const chainState = !chain ? 'checking' : chain.valid ? 'ok' : 'bad';

  return (
    <div className="vb-audit">
      <section className={`vb-card vb-audit-integrity vb-audit-integrity-${chainState}`} aria-live="polite">
        <span className="vb-audit-seal" aria-hidden="true">
          {chainState === 'bad' ? <ShieldAlert size={22} /> : <ShieldCheck size={22} />}
        </span>
        <div className="vb-audit-integrity-text">
          <h2>
            {chainState === 'checking' && 'Checking the decision trail…'}
            {chainState === 'ok' && 'Decision trail intact'}
            {chainState === 'bad' && 'Decision trail broken'}
          </h2>
          <p>
            {chainState === 'ok' && <>All <b>{chain.checked}</b> records re-hashed from the first one; every link still matches. Checked {timeAgo(chain.at)}.</>}
            {chainState === 'bad' && <>Record <span className="vb-mono">{shortHash(chain.brokenAt)}</span> no longer matches its hash, so it and every record after it can't be trusted. Checked {timeAgo(chain.at)}.</>}
            {chainState === 'checking' && 'Re-hashing every recorded decision from the first one.'}
          </p>
          <p className="vb-dim vb-audit-integrity-note">Tamper-evident, not tamper-proof: it shows that a record changed, not who changed it.</p>
        </div>
        <button type="button" className="vb-btn vb-btn-sm" onClick={verifyNow} disabled={verifying}>
          <RefreshCw size={14} className={verifying ? 'vb-audit-spin' : undefined} /> {verifying ? 'Verifying…' : 'Verify again'}
        </button>
      </section>

      {loadError && <Banner kind="error">Could not load audit requests: {loadError.message}</Banner>}

      <div className="vb-audit-grid">
        <section className="vb-audit-list" aria-labelledby="vb-audit-list-title">
          <div className="vb-audit-list-head">
            <h2 id="vb-audit-list-title">Auditor requests</h2>
            <span className="vb-dim vb-small">{requests ? `${openCount} open of ${requests.length}` : ''}</span>
            <button type="button" className={`vb-btn vb-btn-sm${showNew ? '' : ' vb-btn-primary'}`} onClick={openNewForm} aria-expanded={showNew}>
              {showNew ? <X size={15} /> : <Plus size={15} />} {showNew ? 'Cancel' : 'New request'}
            </button>
          </div>

          {showNew && (
            <form className="vb-card vb-audit-new" onSubmit={handleCreate}>
              <label className="vb-field"><span>What is the auditor asking for?</span>
                <input required value={newDescription} onChange={(e) => setNewDescription(e.target.value)} placeholder="Q4 vendor invoice sample" />
              </label>
              <label className="vb-field"><span>Requested by</span>
                <input value={newRequestedBy} onChange={(e) => setNewRequestedBy(e.target.value)} placeholder="Internal Audit" />
              </label>
              <fieldset className="vb-audit-pick">
                <legend>Invoices to include <span className="vb-dim">({picked.size} chosen)</span></legend>
                {!invoices && <Spinner label="Loading invoices…" />}
                {invoices && invoices.length === 0 && <p className="vb-dim vb-small">No invoices yet.</p>}
                {invoices && invoices.length > 0 && (
                  <div className="vb-audit-pick-list">
                    {invoices.map((inv) => (
                      <label key={inv.id} className="vb-audit-pick-row">
                        <input type="checkbox" checked={picked.has(inv.id)} onChange={() => togglePick(inv.id)} />
                        <span className="vb-mono">{inv.invoiceNumber}</span>
                        <span className="vb-audit-pick-vendor">{inv.vendor}</span>
                        <span className="vb-mono vb-audit-pick-amt">{formatMoney(inv.amount, inv.currency)}</span>
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>
              <div className="vb-modal-actions">
                <button type="submit" className="vb-btn vb-btn-primary" disabled={!newDescription.trim()}>Create request</button>
              </div>
            </form>
          )}

          {!requests && !loadError && <div className="vb-pad"><Spinner label="Loading requests…" /></div>}
          {requests && requests.length === 0 && (
            <Empty title="No auditor requests yet">When an auditor asks for evidence, record it here and link the invoices it covers.</Empty>
          )}
          {requests && requests.length > 0 && (
            <div className="vb-rows">
              {requests.map((r) => {
                const st = STATUS[r.status] ?? STATUS.open;
                const tie = REQUEST_TIE_OUT[r.tie_out_status] ?? REQUEST_TIE_OUT.none;
                return (
                  <button key={r.request_id} type="button" className="vb-audit-req" aria-current={r.request_id === selectedId} onClick={() => setSelectedId(r.request_id)}>
                    <span className="vb-audit-req-title">{r.description}</span>
                    <span className="vb-audit-req-sub">{r.requested_by} · {r.date_requested} · {r.linked_count} invoice{r.linked_count === 1 ? '' : 's'}</span>
                    <span className="vb-inline">
                      <span className={`vb-chip ${st.cls}`}>{st.label}</span>
                      <span className={`vb-chip ${tie.cls}`}>{tie.label}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="vb-card vb-audit-detail" aria-label="Selected request">
          {!selected && <Empty title="Pick a request">Choose a request on the left to see its invoices and their trails.</Empty>}
          {selected && (
            <>
              <header className="vb-audit-detail-head">
                <div>
                  <p className="vb-audit-ref vb-mono" title={selected.request_id}>{shortRef(selected.request_id)}</p>
                  <h2>{selected.description}</h2>
                  <p className="vb-muted vb-small">Requested by <b>{selected.requested_by}</b> on {selected.date_requested}</p>
                </div>
                <span className={`vb-chip ${(STATUS[selected.status] ?? STATUS.open).cls}`}>{(STATUS[selected.status] ?? STATUS.open).label}</span>
              </header>

              <div className="vb-audit-actions">
                <input type="file" ref={fileInputRef} hidden onChange={handleFile} />
                <button type="button" className="vb-btn vb-btn-sm" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                  <Paperclip size={14} /> {uploading ? 'Uploading…' : 'Attach a file'}
                </button>
                {selected.status !== 'closed' && !confirmingClose && (
                  <button type="button" className="vb-btn vb-btn-sm" onClick={() => setConfirmingClose(true)}>Close request</button>
                )}
                {selected.status !== 'closed' && confirmingClose && (
                  <span className="vb-inline vb-audit-confirm">
                    <span className="vb-small">Close this request? It can't be reopened here.</span>
                    <button type="button" className="vb-btn vb-btn-sm vb-btn-primary" onClick={handleClose}>Yes, close it</button>
                    <button type="button" className="vb-btn vb-btn-sm" onClick={() => setConfirmingClose(false)}>Keep open</button>
                  </span>
                )}
              </div>

              {files.length > 0 && (
                <div className="vb-audit-files" aria-label="Attached files">
                  {files.map((f) => (
                    <span key={f.id} className="vb-chip vb-chip-neutral" title={`Attached ${f.uploadedAt} by ${f.uploadedBy}`}>
                      <FileText size={12} aria-hidden="true" /> {f.filename}
                    </span>
                  ))}
                </div>
              )}

              <div className="vb-audit-block">
                <h3><MessageSquareText size={15} aria-hidden="true" /> Ask about this request</h3>
                <form className="vb-ask-row" onSubmit={handleAsk}>
                  <input
                    className="vb-input vb-ask-input"
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    placeholder={selected.linked_count ? 'e.g. Why was this invoice held, and who approved it?' : 'No invoices are linked to this request'}
                    disabled={!selected.linked_count || asking}
                    aria-label="Question about this request"
                  />
                  <button type="submit" className="vb-btn vb-btn-primary" disabled={!selected.linked_count || asking || !question.trim()}>
                    {asking ? 'Thinking…' : 'Ask'}
                  </button>
                </form>
                <p className="vb-field-hint">
                  Answered only from the recorded decisions of the invoices below, one answer per invoice, each citing the records it used.
                  {selected.linked_count > 10 && ' Each invoice is a separate AI call, so a large request takes a while.'}
                </p>
                {asking && <Spinner label={`Reading the trails of ${selected.linked_count} invoice${selected.linked_count === 1 ? '' : 's'}…`} />}
                {answers && answers.length === 0 && <p className="vb-dim vb-small">Nothing to answer from: none of the linked invoices has a recorded decision yet.</p>}
                {answers && answers.map((a, i) => (
                  <div key={a.invoiceId ?? i} className="vb-explain vb-audit-answer">
                    <div className="vb-explain-label">{a.invoiceNumber ?? 'Invoice'}</div>
                    <p>{a.answer}</p>
                    <p className={`vb-small ${a.grounded ? 'vb-dim' : 'vb-audit-caution'}`}>{groundingNote(a)}</p>
                  </div>
                ))}
              </div>

              <div className="vb-audit-block">
                <div className="vb-audit-ev-head">
                  <h3>Evidence <span className="vb-tab-n">{shown.length} of {allForSelected.length}</span></h3>
                  <div className="vb-inline vb-audit-filters">
                    <select className="vb-input" value={tieFilter} onChange={(e) => setTieFilter(e.target.value)} aria-label="Filter by outcome">
                      <option value="all">Any outcome</option>
                      <option value="matched">Cleared</option>
                      <option value="discrepant">Not cleared</option>
                    </select>
                    <select className="vb-input" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} aria-label="Filter by tag">
                      <option value="all">Any tag</option>
                      {TAGS.map(([code, name]) => <option key={code} value={code}>{code} · {name}</option>)}
                    </select>
                    <select className="vb-input" value={minAmount} onChange={(e) => setMinAmount(Number(e.target.value))} aria-label="Minimum amount">
                      <option value={0}>Any amount</option>
                      <option value={10000}>Over 10,000</option>
                      <option value={30000}>Over 30,000</option>
                    </select>
                  </div>
                </div>

                {allForSelected.length === 0 && (
                  <Empty title="No invoices linked">This request has no invoices yet, so there is no evidence to show.</Empty>
                )}
                {allForSelected.length > 0 && shown.length === 0 && <p className="vb-dim vb-small">No evidence matches these filters.</p>}

                <div className="vb-audit-evidence">
                  {shown.map((ev) => {
                    const out = evidenceOutcome(ev);
                    return (
                      <article key={ev.evidence_id} className={`vb-audit-ev vb-audit-ev-${out.tone}`}>
                        <div className="vb-audit-ev-top">
                          <div className="vb-audit-ev-name">
                            <Link to={`/app/invoice/${encodeURIComponent(ev.invoice_id)}`} className="vb-mono">{ev.invoice_number || ev.invoice_id}</Link>
                            <span className="vb-muted">{ev.vendor}</span>
                          </div>
                          <span className="vb-mono vb-audit-ev-amt">{formatMoney(ev.amount, ev.currency)}</span>
                          <span className={`vb-chip ${out.cls}`}>{out.label}</span>
                        </div>
                        {ev.tie_out_status === 'discrepant' && (() => {
                          const why = discrepancyWords(ev.discrepancy_reason);
                          return (
                            <p className="vb-audit-ev-why">
                              {why.label ? <span className="vb-mono vb-audit-ev-code">{why.label}</span> : 'Held or rejected before it cleared.'}
                              {why.means && <> {why.means}</>}{' '}
                              <Link to={`/app/invoice/${encodeURIComponent(ev.invoice_id)}`}>Open the full trail</Link>
                            </p>
                          );
                        })()}
                        <div className="vb-audit-ev-meta">
                          <span className="vb-inline">
                            {ev.control_objective_tags.map((t) => <span key={t} className="vb-audit-tag vb-mono" title={(TAGS.find(([c]) => c === t) ?? [])[1]}>{t}</span>)}
                          </span>
                          <span className="vb-inline vb-audit-att">
                            {ev.agent_attestations.map((a) => <span key={a}>{a}</span>)}
                          </span>
                        </div>
                        <div className="vb-audit-ev-foot vb-dim">
                          <span>Latest record <span className="vb-mono" title={ev.attestation_hash}>{shortHash(ev.attestation_hash)}</span></span>
                        </div>
                      </article>
                    );
                  })}
                </div>
                {allForSelected.length > 0 && (
                  <p className="vb-field-hint">Tags are VeriBook's own grouping of exception reasons, not codes from a standard control framework.</p>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
