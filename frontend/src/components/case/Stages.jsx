import React, { useState } from 'react';
import { ShieldCheck, ShieldAlert, Copy } from 'lucide-react';
import { api } from '../../services/api';
import { useToasts } from '../../state/Toasts';
import { Spinner } from '../ui';
import Narrative from './Narrative';
import { ListenButton } from './AskVoice';
import { useSpeech } from '../../lib/useSpeech';
import { buildSpokenAnswer } from '../../lib/speech';
import { actionWords, actorWords, groundingNote, normalizeAction, outcomeWords, shortHash, timeAgo, STAGE_HELP } from '../../lib/labels';
import { STAGE_GUIDE, KIND_LABEL, GATE_WORDS } from '../../lib/stageGuide';

const BAD = new Set(['error', 'payment_failed', 'disagreement']);
const WARN = new Set(['escalate_l1', 'escalate_l2', 'block', 'block_fraud_flag', 'auto_reject', 'human_rejected', 'human_contested']);
const GOOD = new Set(['pass', 'parsed', 'extracted', 'auto_approve', 'human_approved', 'no_payment', 'paid_less_credit']);
const tone = (raw) => { const a = normalizeAction(raw); return BAD.has(a) ? 'bad' : WARN.has(a) ? 'warn' : GOOD.has(a) ? 'good' : 'neutral'; };

/** An engine finding written as "EXC-PRICE_VAR: escalate_l1" is shown as a labelled row rather than prose. */
const FINDING = /^(EXC-[A-Z_]+|R99_AGENT_ERROR|CLEAN_MATCH|POLICY_LIMIT|INVESTIGATOR_HOLD):\s*([a-z_0-9]+)$/;

/** "duplicate: passed" -> a checklist row in plain words. */
const GATE = /^([a-z_]+): (passed|failed - (.+))$/;

function Gates({ claims }) {
  const rows = claims.map((c) => GATE.exec(c)).filter(Boolean);
  return (
    <ul className="vb-gates">
      {rows.map((m) => (
        <li key={m[1]} className={m[2] === 'passed' ? 'is-ok' : 'is-bad'}>
          <span aria-hidden="true">{m[2] === 'passed' ? '✓' : '✕'}</span> {GATE_WORDS[m[1]] ?? m[1].replace(/_/g, ' ')}
          {m[3] && <span className="vb-dim">: {m[3]}</span>}
        </li>
      ))}
    </ul>
  );
}

function Claim({ text, reasonNames }) {
  const m = text.match(FINDING);
  if (m) {
    return (
      <div className="vb-finding">
        <span className="vb-tok vb-tok-code">{m[1]}</span>
        <b>{reasonNames[m[1]] ?? m[1]}</b>
        <span className="vb-muted">&rarr; {actionWords(m[2])} <span className="vb-dim vb-mono">({m[2]})</span></span>
      </div>
    );
  }
  return <Narrative text={text} reasonNames={reasonNames} />;
}

/** One card per step: what the step is, what it concluded and who by, the reasoning, and a way to ask why. */
export default function Stages({ invoice }) {
  const toast = useToasts();
  const speech = useSpeech();
  const [explaining, setExplaining] = useState(null);
  const [answers, setAnswers] = useState({});
  const reasonNames = invoice.reasonNames ?? {};

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

  return (
    <ol className="vb-stages-list">
      {invoice.decisions.map((d, i) => {
        const human = d.nodeId === 'human_review';
        const t = tone(d.actionTaken);
        const a = answers[d.id];
        const g = STAGE_GUIDE[d.nodeId];
        const kind = g ? KIND_LABEL[g.kind] : null;
        const gateClaims = d.nodeId === 'validate' ? d.claims.filter((c) => GATE.test(c)) : [];
        const otherClaims = d.claims.filter((c) => !gateClaims.includes(c));
        return (
          <li key={d.id} className={`vb-stage vb-stage-${t}`}>
            <span className="vb-stage-n" aria-hidden="true">{i + 1}</span>
            <div className="vb-stage-body">
              <header className="vb-stage-head">
                <div>
                  <h4>
                    {g?.name ?? d.label}
                    {kind && <span className={`vb-kind vb-kind-${g.kind}`} title={kind.title}>{kind.label}</span>}
                  </h4>
                  <div className="vb-dim vb-small vb-stage-what">{g?.what ?? STAGE_HELP[d.nodeId] ?? ''}</div>
                </div>
                <span className={`vb-outcome vb-outcome-${t}`}>{outcomeWords(d, invoice)}</span>
              </header>

              <div className="vb-stage-meta">
                <span><span className="vb-dim">By</span> {actorWords(d)}</span>
                <span><span className="vb-dim">When</span> {timeAgo(d.at)}</span>
                {d.confidence != null && (
                  <span className="vb-conf-wrap" title="What this step reported about itself; not an accuracy score">
                    <span className="vb-dim">Sure</span>
                    <span className="vb-conf"><i style={{ width: `${Math.min(100, d.confidence)}%` }} /></span>
                    <b className="vb-mono">{d.confidence}%</b>
                  </span>
                )}
              </div>

              {d.claims.length > 0 && (
                <div className="vb-stage-claims">
                  {gateClaims.length > 0 && <Gates claims={gateClaims} />}
                  {otherClaims.map((c, k) => <Claim key={k} text={c} reasonNames={reasonNames} />)}
                </div>
              )}

              {a && (
                <div className="vb-explain" role="note">
                  <div className="vb-explain-label">Explained</div>
                  <Narrative text={a.answer || 'No explanation was returned.'} reasonNames={reasonNames} />
                  <div className="vb-dim vb-small" style={{ marginTop: 6 }}>{groundingNote(a)}</div>
                  <div className="vb-ask-actions">
                    <ListenButton speech={speech} id={d.id} text={buildSpokenAnswer(a, { reasonNames })} />
                  </div>
                </div>
              )}

              <footer className="vb-stage-foot">
                {!human && (
                  <button type="button" className="vb-btn vb-btn-sm" onClick={() => ask(d)} disabled={explaining === d.id}
                    title="An AI explains this step in plain words, using only this invoice's recorded decisions, and says which records it relied on.">
                    {explaining === d.id ? <Spinner label="Asking…" /> : 'Why did it conclude this?'}
                  </button>
                )}
                <details className="vb-tech">
                  <summary>About this step</summary>
                  {g && <dl><dt>Why it is there</dt><dd>{g.why}</dd><dt>When it runs</dt><dd>{g.when}</dd></dl>}
                  <dl>
                    <dt>Record</dt><dd className="vb-mono">{d.id}</dd>
                    <dt>Hash</dt><dd className="vb-mono">{d.hash}</dd>
                    <dt>Recorded</dt><dd>{new Date(d.at).toLocaleString()}</dd>
                    {d.reasonCode && <><dt>Reason code</dt><dd className="vb-mono">{d.reasonCode}</dd></>}
                  </dl>
                </details>
              </footer>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Verify that this invoice's chain of records has not been altered. */
export function Integrity({ invoice }) {
  const toast = useToasts();
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const verify = async () => {
    setBusy(true);
    try {
      setResult(await api.verifyInvoiceTrail(invoice.id));
    } catch (e) {
      // A 409 means a record's hash no longer matches: that IS the answer, not an error to hide.
      setResult({ sealed: false, error: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="vb-muted vb-small" style={{ marginTop: 0 }}>
        Each step above is chained to the one before it with SHA-256, so changing any past record breaks every record after it. This checks each of this invoice's records, and its links to the records just before and after it in the chain.
      </p>
      <div className="vb-inline">
        <button type="button" className="vb-btn vb-btn-sm" onClick={verify} disabled={busy}>
          {busy ? <Spinner label="Checking…" /> : <><ShieldCheck size={14} /> Verify this trail</>}
        </button>
        {result && (result.sealed
          ? <span className="vb-chain"><span className="vb-dot vb-dot-ok" /> {result.decisionsVerified} records intact</span>
          : <span className="vb-chain" style={{ color: 'var(--vb-danger)' }}><ShieldAlert size={14} /> {result.error || 'A record was altered'}</span>)}
        <button type="button" className="vb-link-btn" onClick={() => navigator.clipboard?.writeText(invoice.hash).then(() => toast.success('Hash copied'), () => toast.error('Could not copy'))}>
          <Copy size={12} style={{ verticalAlign: -1 }} /> Copy the latest hash ({shortHash(invoice.hash)})
        </button>
      </div>
    </div>
  );
}
