import React, { useEffect, useMemo, useState } from 'react';
import { explainCase } from '../../lib/caseExplain';
import { api } from '../../services/api';
import { useInvoices } from '../../state/Invoices';
import { useReviewer } from '../../state/Reviewer';
import { useToasts } from '../../state/Toasts';
import { Spinner } from '../ui';
import { formatMoney } from '../../lib/labels';

/** Approve / Challenge / Reject. Which are available, and why not, comes from the server (`invoice.actions`). */
export default function DecisionPanel({ invoice }) {
  const { patch, refresh } = useInvoices();
  const { withReviewer } = useReviewer();
  const toast = useToasts();
  const [form, setForm] = useState(null); // 'approve' | 'reject' | 'contest' | null
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const { actions } = invoice;

  // A different invoice, or a changed state, closes any half-filled form.
  useEffect(() => { setForm(null); setNote(''); }, [invoice.id, invoice.rawStatus]);

  const act = (fn, onDone) => withReviewer(async (reviewer) => {
    setBusy(true);
    try {
      const res = await fn(reviewer);
      if (res?.invoice) patch(res.invoice);
      onDone(res);
      setForm(null);
      setNote('');
    } catch (e) {
      toast.error(e.message);
      if (e.status === 409 || e.status === 404) refresh(); // the invoice moved on without us: show its real state
    } finally {
      setBusy(false);
    }
  });

  const approve = () => act(
    (r) => api.approveInvoice(invoice.id, r, note.trim() || undefined),
    (res) => {
      if (res.alreadyDone) toast.info('This invoice was already approved.');
      else if (res.paymentError) toast.error(`Approved and posted to the ledger, but the payment did not go out: ${res.paymentError}`);
      else if (res.noPayment === 'credit_memo') toast.success(`Approved. The credit is posted to the ledger and lowers what you owe ${invoice.vendor}; nothing is paid.`);
      else if (res.noPayment === 'covered_by_credit') toast.success(`Approved and posted to the ledger. Credit already approved from ${invoice.vendor} covers all of it, so nothing is paid.`);
      else toast.success('Approved, posted to the ledger and paid (simulated rail: no money moved).');
    },
  );
  const reject = () => act(
    (r) => api.rejectInvoice(invoice.id, r, note.trim() || undefined),
    (res) => toast.success(res.alreadyDone ? 'This invoice was already rejected.' : 'Rejected. It will not be posted or paid.'),
  );
  const contest = () => act(
    (r) => api.contestInvoice(invoice.id, r, note.trim()),
    (res) => {
      const x = res.reconsideration;
      if (!x.possible) toast.info(`Challenge recorded. ${x.reason}.`);
      else if (x.failed) toast.error(`Challenge recorded, but the AI re-review failed: ${x.error}`);
      else if (x.escalatedToSenior) toast.info(x.message);
      else toast.success(x.cascaded ? 'The AI re-reviewed it and the outcome changed.' : 'The AI re-reviewed it; the outcome is unchanged.');
    },
  );

  const LABEL = { approve: 'Approve', contest: 'Challenge', reject: 'Reject' };
  const choices = useMemo(() => explainCase(invoice).choices, [invoice]);

  if (invoice.state === 'processing') {
    return <p className="vb-muted vb-small">The automatic checks are still running. Decisions open up when they finish.</p>;
  }

  return (
    <div>
      <div className="vb-actions">
        <button type="button" className="vb-btn vb-btn-primary" disabled={!actions.approve.allowed || busy} title={choices.approve} onClick={() => setForm(form === 'approve' ? null : 'approve')}>Approve</button>
        <button type="button" className="vb-btn" disabled={!actions.contest.allowed || busy} title={choices.contest} onClick={() => setForm(form === 'contest' ? null : 'contest')}>Challenge</button>
        <button type="button" className="vb-btn vb-btn-danger" disabled={!actions.reject.allowed || busy} title={choices.reject} onClick={() => setForm(form === 'reject' ? null : 'reject')}>Reject</button>
      </div>
      {!form && (
        <dl className="vb-choices" aria-label="What each button does">
          {['approve', 'contest', 'reject'].map((k) => (
            <div key={k} className={actions[k].allowed ? undefined : 'is-off'}>
              <dt>{LABEL[k]}</dt><dd>{choices[k]}</dd>
            </div>
          ))}
        </dl>
      )}

      {form && (
        <div className="vb-action-form">
          {form === 'approve' && (invoice.invoiceType === 'credit_memo'
            ? <p className="vb-muted vb-small" style={{ margin: 0 }}>Approving posts this credit of <b>{formatMoney(invoice.amount, invoice.currency)}</b> to the ledger: it lowers what you owe {invoice.vendor}, first on its own invoice if that is still open, then on their next approved invoices. Nothing is paid. Your name goes on the record.</p>
            : <p className="vb-muted vb-small" style={{ margin: 0 }}>Approving posts <b>{formatMoney(invoice.amount, invoice.currency)}</b> to the ledger and pays it, less any approved credit from {invoice.vendor} not yet used (simulated rail). Your name goes on the record.</p>)}
          {form === 'contest' && <p className="vb-muted vb-small" style={{ margin: 0 }}>Ask the AI to look again. Tell it what it may have missed; it answers exactly what you ask. It can only make the outcome stricter, never approve something the rules flagged.</p>}
          {form === 'reject' && <p className="vb-muted vb-small" style={{ margin: 0 }}>Rejecting marks it void. It will not be posted or paid. Your name goes on the record.</p>}
          <label className="vb-field">
            <span>{form === 'contest' ? 'What should it reconsider? (required)' : 'Note (optional)'}</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={form === 'contest' ? 1000 : 2000}
              placeholder={form === 'contest' ? 'e.g. The new unit price was agreed on 3 Oct.' : form === 'reject' ? 'Why are you rejecting it?' : 'e.g. The new price was agreed before ordering.'} />
            {form === 'contest' && <span className="vb-field-hint">At least 10 characters.</span>}
          </label>
          <div className="vb-action-form-actions">
            <button type="button" className="vb-btn vb-btn-sm" onClick={() => setForm(null)} disabled={busy}>Cancel</button>
            {form === 'approve' && <button type="button" className="vb-btn vb-btn-primary" onClick={approve} disabled={busy}>{busy ? <Spinner label="Posting…" /> : 'Confirm approval'}</button>}
            {form === 'reject' && <button type="button" className="vb-btn vb-btn-danger" onClick={reject} disabled={busy}>{busy ? <Spinner label="Rejecting…" /> : 'Confirm rejection'}</button>}
            {form === 'contest' && <button type="button" className="vb-btn vb-btn-primary" onClick={contest} disabled={busy || note.trim().length < 10}>{busy ? <Spinner label="AI is re-reviewing…" /> : 'Send for AI re-review'}</button>}
          </div>
        </div>
      )}

    </div>
  );
}

/** Shared by the page for the "Retry AI review" shortcut. */
export function useContestShortcut(invoice) {
  const { patch, refresh } = useInvoices();
  const { withReviewer } = useReviewer();
  const toast = useToasts();
  const [busy, setBusy] = useState(false);
  const retry = () => withReviewer(async (reviewer) => {
    setBusy(true);
    try {
      const res = await api.contestInvoice(invoice.id, reviewer, 'Retry the AI review after an error');
      if (res?.invoice) patch(res.invoice);
      const x = res.reconsideration;
      if (x.failed) toast.error(`The AI re-review failed again: ${x.error}`);
      else toast.success(x.cascaded ? 'The AI re-reviewed it and the outcome changed.' : 'The AI re-reviewed it; the outcome is unchanged.');
    } catch (e) {
      toast.error(e.message);
      if (e.status === 409 || e.status === 404) refresh();
    } finally {
      setBusy(false);
    }
  });
  return { retry, busy };
}
