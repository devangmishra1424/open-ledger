import React, { useState } from 'react';
import { Check } from 'lucide-react';
import { api } from '../../services/api';
import { useInvoices } from '../../state/Invoices';
import { useReviewer } from '../../state/Reviewer';
import { useToasts } from '../../state/Toasts';
import { Banner } from '../ui';

/**
 * The vendor bank-detail verification as three steps: phone the vendor, record what they said, a
 * DIFFERENT person signs off. Which step is current, and who may do it, comes from the server;
 * the server enforces the same rules (lib/ledger/bank-change-review.ts).
 */
export default function BankChangeSteps({ invoice }) {
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
      patch(await api.getInvoiceById(invoice.id));
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
      <Banner kind="error">
        <strong>The vendor did not confirm the change.</strong> The vendor is flagged and its invoices stay blocked. Reject this invoice, or contact your treasury team.
      </Banner>
    );
  }

  const change = bc.oldBankLast4 && bc.newBankLast4
    ? `The bank account on file changed from one ending ${bc.oldBankLast4} to one ending ${bc.newBankLast4}.`
    : bc.newBankLast4 ? `The vendor’s bank account now ends in ${bc.newBankLast4} and was changed recently.` : 'The vendor’s bank account was changed recently.';

  return (
    <div>
      <p className="vb-muted vb-small">{change} Nothing can be paid until a person has phoned the vendor and a second person has signed off.</p>
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
                    <input className="vb-input" style={{ maxWidth: 200 }} placeholder="Number you are dialing" value={phone} onChange={(e) => setPhone(e.target.value)} aria-label="Number you are dialing" />
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
                  <p>{iAmCaller ? 'You made the call, so someone else has to sign off. Ask a colleague to open this invoice and use their own name.' : 'You are not the person who made the call, so you can sign off.'}</p>
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
    </div>
  );
}
