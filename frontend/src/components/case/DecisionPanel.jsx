import React, { useEffect, useState } from 'react';
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
  const disabledReasons = ['approve', 'contest', 'reject'].filter((k) => !actions[k].allowed && actions[k].reason).map((k) => [k, actions[k].reason]);

  if (invoice.state === 'processing') {
    return <p className="vb-muted vb-small">The automatic checks are still running. Decisions open up when they finish.</p>;
  }

  return (
    <div>
      <div className="vb-actions">
        <button type="button" className="vb-btn vb-btn-primary" disabled={!actions.approve.allowed || busy} onClick={() => setForm(form === 'approve' ? null : 'approve')}>Approve</button>
        <button type="button" className="vb-btn" disabled={!actions.contest.allowed || busy} onClick={() => setForm(form === 'contest' ? null : 'contest')}>Challenge</button>
        <button type="button" className="vb-btn vb-btn-danger" disabled={!actions.reject.allowed || busy} onClick={() => setForm(form === 'reject' ? null : 'reject')}>Reject</button>
      </div>

      {form && (
        <div className="vb-action-form">
          {form === 'approve' && <p className="vb-muted vb-small" style={{ margin: 0 }}>Approving posts <b>{formatMoney(invoice.amount, invoice.currency)}</b> to the ledger and pays it (simulated rail). Your name goes on the record.</p>}
          {form === 'contest' && <p className="vb-muted vb-small" style={{ margin: 0 }}>Ask the AI to look again. Tell it what it may have missed; it answers exactly what you ask. It can only make the outcome stricter, never approve something the rules flagged.</p>}
          {form === 'reject' && <p className="vb-muted vb-small" style={{ margin: 0 }}>Rejecting marks it void. It will not be posted or paid. Your name goes on the record.</p>}
          <label className="vb-field">
            <span>{form === 'contest' ? 'What should it reconsider? (required)' : 'Note (optional)'}</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={form === 'contest' ? 1000 : 2000}
              placeholder={form === 'contest' ? 'e.g. The vendor confirmed the new unit price in writing on 3 Oct.' : form === 'reject' ? 'Why are you rejecting it?' : 'e.g. Price confirmed with the vendor.'} />
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

      {disabledReasons.length > 0 && (
        <ul className="vb-disabled-reasons">
          {disabledReasons.map(([k, reason]) => <li key={k}><b>{LABEL[k]}</b> is unavailable: {reason}.</li>)}
        </ul>
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
