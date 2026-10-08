import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, ShieldCheck, ShieldAlert, Copy, RotateCcw, HelpCircle } from 'lucide-react';
import { api } from '../services/api';
import { useInvoices } from '../state/Invoices';
import { useReviewer } from '../state/Reviewer';
import { useToasts } from '../state/Toasts';
import { Banner, Spinner, StateChip } from './ui';
import { actionWords, actorWords, formatMoney, shortHash, timeAgo } from '../lib/labels';

/**
 * One invoice, laid out in the order a reviewer needs it: what it is, WHY it is here, what they
 * can do (with the reason when they cannot), then the evidence and the full decision trail.
 * Which buttons are available comes from the server (`invoice.actions`), computed by the same
 * rules the server enforces, so a button is never offered that will then be refused.
 */
export default function CasePanel({ invoice, onClose }) {
  const { patch, refresh } = useInvoices();
  const { withReviewer } = useReviewer();
  const toast = useToasts();
  const [form, setForm] = useState(null); // 'approve' | 'reject' | 'contest' | null
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // A different invoice, or a changed state, closes any half-filled decision form.
  useEffect(() => { setForm(null); setNote(''); }, [invoice.id, invoice.rawStatus]);

  // If the most recent AI step ended in an error, say so and offer a retry (a retry is a "challenge" the server re-runs).
  const lastError = useMemo(() => {
    const lastAi = [...invoice.decisions].reverse().find((d) => d.nodeId === 'investigate' || d.nodeId === 'verify');
    return invoice.state === 'needs_attention' && lastAi?.actionTaken === 'error' ? lastAi : null;
  }, [invoice.decisions, invoice.state]);

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
      // Most failures here mean the invoice moved on without us (409): show its real state.
      if (e.status === 409 || e.status === 404) refresh();
    } finally {
      setBusy(false);
    }
  });

  const approve = () => act(
    (reviewer) => api.approveInvoice(invoice.id, reviewer, note.trim() || undefined),
    (res) => {
      if (res.alreadyDone) toast.info('This invoice was already approved.');
      else if (res.paymentError) toast.error(`Approved and posted to the ledger, but the payment did not go out: ${res.paymentError}`);
      else toast.success('Approved, posted to the ledger and paid (simulated rail: no money moved).');
    },
  );

  const reject = () => act(
    (reviewer) => api.rejectInvoice(invoice.id, reviewer, note.trim() || undefined),
    (res) => toast.success(res.alreadyDone ? 'This invoice was already rejected.' : 'Rejected. It will not be posted or paid.'),
  );

  const contest = (reason = note.trim()) => act(
    (reviewer) => api.contestInvoice(invoice.id, reviewer, reason),
    (res) => {
      const r = res.reconsideration;
      if (!r.possible) toast.info(`Challenge recorded. ${r.reason}.`);
      else if (r.failed) toast.error(`Challenge recorded, but the AI re-review failed: ${r.error}`);
      else if (r.escalatedToSenior) toast.info(r.message);
      else toast.success(r.cascaded ? 'The AI re-reviewed it and the outcome changed.' : 'The AI re-reviewed it; the outcome is unchanged.');
    },
  );

  const { actions } = invoice;
  const LABEL = { approve: 'Approve', contest: 'Challenge', reject: 'Reject' };
  const disabledReasons = ['approve', 'contest', 'reject']
    .filter((k) => !actions[k].allowed && actions[k].reason)
    .map((k) => `${LABEL[k]}: ${actions[k].reason}`);

  const itemsTotal = invoice.items.reduce((s, i) => s + i.amount, 0);
  const otherAmount = Math.round((invoice.amount - itemsTotal) * 100) / 100;

  return (
    <aside className="vb-card vb-case" aria-label={`Invoice ${invoice.vendor}`}>
      <button type="button" className="vb-btn vb-btn-sm vb-case-back" onClick={onClose}><ArrowLeft size={14} /> Back to list</button>

      <header className="vb-case-head">
        <div className="vb-case-title">
          <div>
            <h2 className="vb-case-vendor">{invoice.vendor}</h2>
            <div className="vb-muted vb-mono" style={{ fontSize: 13 }}>{invoice.invoiceNumber}</div>
          </div>
          <StateChip state={invoice.state} />
        </div>
        <div className="vb-case-amount">{formatMoney(invoice.amount, invoice.currency)}</div>
        <dl className="vb-meta">
          <div><dt>Purchase order</dt><dd className="vb-mono">{invoice.poNumber}</dd></div>
          <div><dt>Payment terms</dt><dd>{invoice.terms}</dd></div>
          <div><dt>Invoice date</dt><dd>{invoice.invoiceDate}</dd></div>
          <div><dt>Received</dt><dd>{timeAgo(invoice.receivedDate)}</dd></div>
        </dl>
      </header>

      <section className="vb-section" aria-label="Why it is here">
        <h3>Where it stands</h3>
        <div className={`vb-why vb-why-${invoice.state}`}>
          <strong>{invoice.summary.headline}</strong>
          {invoice.summary.detail && <p>{invoice.summary.detail}</p>}
        </div>
        {lastError && (
          <div style={{ marginTop: 12 }}>
            <Banner kind="warn" action={
              <button type="button" className="vb-btn vb-btn-sm" disabled={busy || !actions.contest.allowed} onClick={() => contest('Retry the AI review after an error')}>
                <RotateCcw size={14} /> Retry AI review
              </button>
            }>
              The {lastError.nodeId === 'verify' ? 'second AI check' : 'AI review'} did not complete ({lastError.claims[0]?.replace(/^(Investigator|Verifier) failed: /, '') || 'error'}). That is why a person has to look at it.
            </Banner>
          </div>
        )}
      </section>

      {invoice.bankChange && <BankChangeSteps invoice={invoice} />}

      {invoice.state !== 'processing' && (
        <section className="vb-section" aria-label="Decide">
          <h3>Your decision</h3>
          <div className="vb-actions">
            <button type="button" className="vb-btn vb-btn-primary" disabled={!actions.approve.allowed || busy} onClick={() => setForm(form === 'approve' ? null : 'approve')}>Approve</button>
            <button type="button" className="vb-btn" disabled={!actions.contest.allowed || busy} onClick={() => setForm(form === 'contest' ? null : 'contest')}>Challenge</button>
            <button type="button" className="vb-btn vb-btn-danger" disabled={!actions.reject.allowed || busy} onClick={() => setForm(form === 'reject' ? null : 'reject')}>Reject</button>
          </div>

          {form && (
            <div className="vb-action-form">
              {form === 'approve' && (
                <p className="vb-muted" style={{ margin: 0, fontSize: 13.5 }}>
                  Approving posts {formatMoney(invoice.amount, invoice.currency)} to the ledger and pays it (simulated rail). Your name goes on the record.
                </p>
              )}
              {form === 'contest' && (
                <p className="vb-muted" style={{ margin: 0, fontSize: 13.5 }}>
                  Ask the AI to look again. Tell it what it may have missed; it answers exactly what you ask. It can only make the outcome stricter, never approve something the rules flagged.
                </p>
              )}
              <label className="vb-field">
                <span>{form === 'contest' ? 'What should it reconsider? (required)' : 'Note (optional)'}</span>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={form === 'contest' ? 1000 : 2000}
                  placeholder={form === 'contest' ? 'e.g. The vendor confirmed the new unit price in writing on 3 Oct.' : form === 'reject' ? 'Why are you rejecting it?' : 'e.g. Price confirmed with the vendor.'}
                />
                {form === 'contest' && <span className="vb-field-hint">At least 10 characters.</span>}
              </label>
              <div className="vb-action-form-actions">
                <button type="button" className="vb-btn vb-btn-sm" onClick={() => setForm(null)} disabled={busy}>Cancel</button>
                {form === 'approve' && <button type="button" className="vb-btn vb-btn-primary" onClick={approve} disabled={busy}>{busy ? <Spinner label="Posting…" /> : 'Confirm approval'}</button>}
                {form === 'reject' && <button type="button" className="vb-btn vb-btn-danger" onClick={reject} disabled={busy}>{busy ? <Spinner label="Rejecting…" /> : 'Confirm rejection'}</button>}
                {form === 'contest' && <button type="button" className="vb-btn vb-btn-primary" onClick={() => contest()} disabled={busy || note.trim().length < 10}>{busy ? <Spinner label="AI is re-reviewing…" /> : 'Send for AI re-review'}</button>}
              </div>
            </div>
          )}

          {disabledReasons.length > 0 && (
            <ul className="vb-disabled-reasons">
              {disabledReasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          )}
        </section>
      )}

      {invoice.humanActions.length > 0 && (
        <section className="vb-section" aria-label="People who acted">
          <h3>People who acted</h3>
          <ul className="vb-timeline">
            {invoice.humanActions.map((h) => (
              <li key={h.decisionId} className="vb-tl-item vb-tl-human">
                <div className="vb-tl-head">
                  <span className="vb-tl-title">{h.reviewer}</span>
                  <span className="vb-tl-result">{{ approve: 'approved it', reject: 'rejected it', contest: 'challenged it' }[h.action]}</span>
                </div>
                {h.note && <div className="vb-muted" style={{ fontSize: 13.5, marginTop: 2 }}>“{h.note}”</div>}
                <div className="vb-tl-sub"><span>{timeAgo(h.at)}</span></div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="vb-section" aria-label="Line items">
        <h3>What was billed</h3>
        <table className="vb-table">
          <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {invoice.items.map((it, i) => (
              <tr key={i}>
                <td>{it.description}</td>
                <td className="num">{it.qty}</td>
                <td className="num">{it.rate.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                <td className="num">{it.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
              </tr>
            ))}
            {otherAmount > 0.005 && (
              <tr><td className="vb-muted">Tax and other</td><td /><td /><td className="num">{otherAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td></tr>
            )}
          </tbody>
          <tfoot>
            <tr><td colSpan={3} style={{ fontWeight: 700, paddingTop: 10 }}>Total</td><td className="num" style={{ fontWeight: 700, paddingTop: 10 }}>{formatMoney(invoice.amount, invoice.currency)}</td></tr>
          </tfoot>
        </table>
      </section>

      <Trail invoice={invoice} />
    </aside>
  );
}

function BankChangeSteps({ invoice }) {
  const { patch, refresh } = useInvoices();
  const { name, withReviewer } = useReviewer();
  const toast = useToasts();
  const bc = invoice.bankChange;
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const order = ['start_callback', 'record_outcome', 'second_signoff'];
  const at = order.indexOf(bc.step);

  const run = (fn, ok) => withReviewer(async (reviewer) => {
    setBusy(true);
    try {
      await fn(reviewer);
      ok();
      const fresh = await api.getInvoiceById(invoice.id);
      patch(fresh);
    } catch (e) {
      toast.error(e.message);
      refresh();
    } finally {
      setBusy(false);
    }
  });

  const iAmCaller = bc.callbackBy && name && bc.callbackBy.trim().toLowerCase() === name.trim().toLowerCase();

  if (bc.step === 'blocked') {
    return (
      <section className="vb-section" aria-label="Bank details check">
        <h3>Vendor bank details</h3>
        <Banner kind="error">The vendor did not confirm the bank-detail change, so the vendor is flagged and its invoices stay blocked. Reject this invoice, or contact your treasury team.</Banner>
      </section>
    );
  }

  return (
    <section className="vb-section" aria-label="Bank details check">
      <h3>Vendor bank details changed: verify before paying</h3>
      <p className="vb-muted" style={{ margin: '0 0 10px', fontSize: 13.5 }}>
        {bc.oldBankLast4 && bc.newBankLast4
          ? `The bank account on file changed from one ending ${bc.oldBankLast4} to one ending ${bc.newBankLast4}.`
          : bc.newBankLast4 ? `The vendor's bank account now ends in ${bc.newBankLast4} and was changed recently.` : `The vendor's bank account was changed recently.`}
        {' '}Redirecting payments to a new account is the most common way payment fraud works, so this invoice cannot be approved until a person phones the vendor and a second person signs off.
      </p>
      {!bc.reviewId ? (
        <Banner kind="info">The matching step will open the verification for this vendor in a moment; reload if this stays.</Banner>
      ) : (
        <div className="vb-steps">
          <div className={`vb-step ${at === 0 ? 'vb-step-current' : 'vb-step-done'}`}>
            <span className="vb-step-n">{at > 0 ? <Check size={14} /> : 1}</span>
            <div className="vb-step-body">
              <strong>Phone the vendor</strong>
              {at === 0 ? (
                <>
                  <p>Use a number from your own vendor records or an earlier trusted invoice, <em>not</em> one from the change request or this invoice.</p>
                  <div className="vb-inline">
                    <input className="vb-input" style={{ maxWidth: 220 }} placeholder="Number you are dialing" value={phone} onChange={(e) => setPhone(e.target.value)} aria-label="Number you are dialing" />
                    <button type="button" className="vb-btn vb-btn-sm vb-btn-primary" disabled={busy || phone.trim().length < 7}
                      onClick={() => run((r) => api.startCallback(bc.reviewId, r, phone.trim()), () => toast.success('Call logged. Now record what the vendor said.'))}>
                      Log the call
                    </button>
                  </div>
                </>
              ) : <p>{bc.callbackBy} called {bc.callbackPhone}.</p>}
            </div>
          </div>

          <div className={`vb-step ${at === 1 ? 'vb-step-current' : at > 1 ? 'vb-step-done' : ''}`}>
            <span className="vb-step-n">{at > 1 ? <Check size={14} /> : 2}</span>
            <div className="vb-step-body">
              <strong>Record what the vendor said</strong>
              {at === 1 && (
                <>
                  <p>{iAmCaller ? 'Did the vendor confirm they asked for this change?' : `Only ${bc.callbackBy}, who made the call, can say the vendor confirmed it. Anyone can report that it was NOT confirmed.`}</p>
                  <div className="vb-inline">
                    <button type="button" className="vb-btn vb-btn-sm vb-btn-primary" disabled={busy || !iAmCaller}
                      onClick={() => run((r) => api.recordCallbackOutcome(bc.reviewId, r, 'confirmed'), () => toast.success('Recorded as confirmed. A second reviewer must now sign off.'))}>
                      Vendor confirmed
                    </button>
                    <button type="button" className="vb-btn vb-btn-sm vb-btn-danger" disabled={busy}
                      onClick={() => run((r) => api.recordCallbackOutcome(bc.reviewId, r, 'failed'), () => toast.info('Recorded as not confirmed. The vendor is flagged and the invoice stays blocked.'))}>
                      Not confirmed / wrong number
                    </button>
                  </div>
                </>
              )}
              {at > 1 && <p>The vendor confirmed.</p>}
            </div>
          </div>

          <div className={`vb-step ${at === 2 ? 'vb-step-current' : ''}`}>
            <span className="vb-step-n">3</span>
            <div className="vb-step-body">
              <strong>A second person signs off</strong>
              {at === 2 && (
                <>
                  <p>{iAmCaller ? `You made the call, so someone else has to sign off. Ask a colleague to open this invoice and use their own name.` : 'You are not the person who made the call, so you can sign off.'}</p>
                  <div className="vb-inline">
                    <button type="button" className="vb-btn vb-btn-sm vb-btn-primary" disabled={busy || iAmCaller}
                      onClick={() => run((r) => api.signOffBankChange(bc.reviewId, r), () => toast.success('Signed off. The hold is lifted and the invoice can be approved.'))}>
                      Sign off
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** A recorded claim can be a paragraph of model reasoning; show the start, keep the rest one click away. */
function ClaimText({ text, limit = 220 }) {
  const [open, setOpen] = useState(false);
  if (text.length <= limit) return text;
  return (
    <>
      {open ? text : `${text.slice(0, limit).trimEnd()}…`}{' '}
      <button type="button" className="vb-link-btn" onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show more'}</button>
    </>
  );
}

function Trail({ invoice }) {
  const toast = useToasts();
  const [explaining, setExplaining] = useState(null);
  const [answers, setAnswers] = useState({});
  const [verify, setVerify] = useState(null);
  const [verifying, setVerifying] = useState(false);

  const ask = async (d) => {
    setExplaining(d.id);
    try {
      const res = await api.explainInvoice(invoice.id, `Why did the "${d.label}" step conclude "${actionWords(d.actionTaken)}"${d.reasonCode ? ` (${d.reasonCode})` : ''}?`, d.id);
      setAnswers((a) => ({ ...a, [d.id]: res }));
    } catch (e) {
      toast.error(`Could not get an explanation: ${e.message}`);
    } finally {
      setExplaining(null);
    }
  };

  const verifyTrail = async () => {
    setVerifying(true);
    try {
      setVerify(await api.verifyInvoiceTrail(invoice.id));
    } catch (e) {
      // 409 means a record's hash no longer matches: that IS the answer, not an error to hide.
      setVerify({ sealed: false, error: e.message, status: e.status });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <section className="vb-section" aria-label="How it was decided">
      <h3>How it was decided</h3>
      <ol className="vb-timeline">
        {invoice.decisions.map((d) => {
          const human = d.nodeId === 'human_review';
          const bad = d.actionTaken === 'error' || d.actionTaken === 'payment_failed';
          const a = answers[d.id];
          return (
            <li key={d.id} className={`vb-tl-item ${human ? 'vb-tl-human' : bad ? 'vb-tl-bad' : 'vb-tl-machine'}`}>
              <div className="vb-tl-head">
                <span className="vb-tl-title">{d.label}</span>
                <span className="vb-tl-result">{actionWords(d.actionTaken)}</span>
                {d.confidence != null && <span className="vb-dim vb-mono" style={{ fontSize: 12 }}>{d.confidence}% sure</span>}
              </div>
              <div className="vb-tl-sub">
                <span>{actorWords(d)}</span>
                <span>{timeAgo(d.at)}</span>
                <span className="vb-mono" title={d.hash}>{shortHash(d.hash)}</span>
                {!human && (
                  <button type="button" className="vb-link-btn" onClick={() => ask(d)} disabled={explaining === d.id}>
                    {explaining === d.id ? 'Asking…' : 'Why?'}
                  </button>
                )}
              </div>
              {d.claims.length > 0 && <ul className="vb-claims">{d.claims.map((c, i) => <li key={i}><ClaimText text={c} /></li>)}</ul>}
              {a && (
                <div className="vb-explain" role="note">
                  {a.answer || 'No explanation was returned.'}
                  <div className="vb-dim" style={{ fontSize: 12, marginTop: 6 }}>
                    {a.grounded ? `Based on ${a.citedDecisionIds.length} recorded decision${a.citedDecisionIds.length === 1 ? '' : 's'}.` : 'This answer did not cite a recorded decision. Treat it with caution.'}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <div className="vb-inline" style={{ marginTop: 4 }}>
        <button type="button" className="vb-btn vb-btn-sm" onClick={verifyTrail} disabled={verifying}>
          {verifying ? <Spinner label="Checking…" /> : <><ShieldCheck size={14} /> Verify this trail</>}
        </button>
        {verify && (verify.sealed
          ? <span className="vb-chain"><span className="vb-dot vb-dot-ok" /> {verify.decisionsVerified} records intact</span>
          : <span className="vb-chain" style={{ color: 'var(--vb-danger)' }}><ShieldAlert size={14} /> {verify.error || 'A record was altered'}</span>)}
        <button type="button" className="vb-link-btn" onClick={() => navigator.clipboard?.writeText(invoice.hash).then(() => toast.success('Hash copied'), () => toast.error('Could not copy'))} title="Copy the hash of the latest record">
          <Copy size={12} style={{ verticalAlign: -1 }} /> copy latest hash
        </button>
      </div>
      <p className="vb-dim" style={{ fontSize: 12, margin: '10px 0 0' }}>
        <HelpCircle size={12} style={{ verticalAlign: -1 }} /> Every step above is chained to the one before it with SHA-256. Changing any past record breaks the chain.
      </p>
    </section>
  );
}
