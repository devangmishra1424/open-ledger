import React, { useMemo } from 'react';
import { RotateCcw } from 'lucide-react';
import { explainCase } from '../../lib/caseExplain';
import { REASON_GUIDE, AUTO_APPROVED_GUIDE } from '../../lib/reasonGuide';
import { Banner, Spinner } from '../ui';

/** The one thing to do next, worded for where this invoice actually is. */
function nextStep(invoice, guide) {
  if (invoice.state === 'processing') return 'The automatic checks are still running. This page updates on its own when they finish.';
  if (invoice.state === 'approved' || invoice.state === 'paid') return 'Nothing. It is posted to the ledger, and every step that led here is recorded below.';
  if (invoice.state === 'rejected') return 'Nothing. It will not be posted or paid. If that was a mistake, it can be challenged for another look.';
  if (invoice.bankChange) {
    return {
      start_callback: 'Phone the vendor on a number from your own records (not one from the invoice), then record what they said, using the steps on the right.',
      record_outcome: 'Record whether the vendor confirmed the change when you called them (right).',
      second_signoff: 'A second person, not the one who phoned, signs off on the callback (right). Then the invoice can be approved.',
      blocked: 'The vendor did not confirm the change, so the vendor is flagged and payment stays blocked. Reject the invoice.',
    }[invoice.bankChange.step];
  }
  if (invoice.reason?.code === 'EXC-BEFORE_RCV') return 'Record the delivery on the Orders page; the invoice is checked again on its own. Or decide it yourself now.';
  if (invoice.reason?.code === 'EXC-NON_PO') return 'If a purchase order exists, link it with "Check it again" (right) and the whole match runs. Otherwise approve it as authorised non-PO spend, or reject it.';
  return `Decide it on the right: approve, reject, or challenge the AI. ${guide?.usually ?? ''}`.trim();
}

/**
 * "Where it stands": the verdict for THIS invoice. What route it is on, what the checks found on it
 * (the lines and numbers, not the general rule), what the AI did and whether it changed anything, and
 * what has to happen next. The general rule for the reason is one click away.
 */
export default function Verdict({ invoice, aiFailed, lastAi, retry, retrying }) {
  const x = useMemo(() => explainCase(invoice), [invoice]);
  const guide = invoice.reason ? REASON_GUIDE[invoice.reason.code] : null;
  const autoApproved = (invoice.state === 'approved' || invoice.state === 'paid') && invoice.summary.decidedBy === 'system';

  return (
    <div className="vb-verdict">
      <div className={`vb-why vb-why-${invoice.state}`}>
        <div className="vb-verdict-top">
          {x.route && <span className={`vb-route vb-route-${x.route.tone}`} title="Where the rules sent this invoice">{x.route.label}</span>}
          {invoice.reason && <span className="vb-tok vb-tok-code" title={`Reason code: ${invoice.reason.name}`}>{invoice.reason.code}</span>}
        </div>
        <strong>{invoice.summary.headline}</strong>
        {x.route && <p>{x.route.meaning}</p>}
      </div>

      {aiFailed && (
        <Banner kind="warn" action={
          <button type="button" className="vb-btn vb-btn-sm" disabled={retrying || !invoice.actions.contest.allowed} onClick={retry}
            title="Runs the AI review again from the same records. Use it once the cause (often a provider limit) has passed.">
            {retrying ? <Spinner label="Retrying…" /> : <><RotateCcw size={14} /> Retry AI review</>}
          </button>
        }>
          The {lastAi.nodeId === 'verify' ? 'second AI check' : 'AI review'} did not complete. That is why a person has to look at it; the invoice itself may be fine.
        </Banner>
      )}

      <div className="vb-verdict-grid">
        <div>
          <h3>What the checks found on this invoice</h3>
          {x.found.length > 0
            ? <ul className="vb-found">{x.found.map((f) => <li key={f}>{f}</li>)}</ul>
            : <p className="vb-muted">{invoice.state === 'processing' ? 'Nothing yet: the checks are still running.' : 'No specific finding was recorded.'}</p>}
        </div>
        <div>
          <h3>What the AI did</h3>
          <ul className="vb-found vb-found-ai">{x.ai.map((a) => <li key={a}>{a}</li>)}</ul>
        </div>
      </div>

      <div className="vb-next">
        <span className="vb-next-label">What happens now</span>
        <span>{nextStep(invoice, guide)}</span>
      </div>

      {guide && !autoApproved && (
        <details className="vb-rule">
          <summary>The rule behind &ldquo;{invoice.reason.name}&rdquo;, and what to check</summary>
          <div className="vb-guide-grid">
            <div>
              <h4>What it means</h4><p>{guide.means}</p>
              <h4>Why it matters</h4><p>{guide.why}</p>
            </div>
            <div>
              <h4>What to check</h4><ul>{guide.check.map((c) => <li key={c}>{c}</li>)}</ul>
              <h4>How these usually end</h4><p>{guide.usually}</p>
            </div>
          </div>
          <p className="vb-guide-engine"><b>What the system does with it on its own:</b> {guide.engine}</p>
        </details>
      )}
      {autoApproved && (
        <details className="vb-rule">
          <summary>Why an invoice like this needs no person</summary>
          <ul>{AUTO_APPROVED_GUIDE.checks.map((c) => <li key={c}>{c}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
