import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, LogIn } from 'lucide-react';
import { useAuth } from '../state/Auth';
import '../styles/landing.css';

/**
 * The public front page. Everything it says is true of the code as it stands (no invented numbers
 * or customers), including the limits at the bottom. It calls no protected endpoint: only the
 * public session check, to decide between "Log in" and "Open the workbench".
 */

const DOCS = [
  { kind: 'Purchase order', ref: 'PO-2024-1150', rows: [['Widget, steel', '10', '$50.00'], ['Fitting kit', '4', '$12.50']], note: 'What was agreed' },
  { kind: 'Goods receipt', ref: 'GRN-0311 · accepted', rows: [['Widget, steel', '10', 'received'], ['Fitting kit', '4', 'received']], note: 'What arrived' },
  { kind: 'Invoice', ref: 'INV-88214', rows: [['Widget, steel', '10', '$50.00'], ['Fitting kit', '4', '$12.50']], note: 'What is billed' },
];

const CHAIN = [
  ['0412', '9f3a…c21e', 'extracted'],
  ['0413', '51b0…7d94', 'pass'],
  ['0414', 'c7e2…0a3f', 'auto_approve'],
  ['0415', '2d88…e61b', 'escalate_l1'],
  ['0416', 'a04c…93d7', 'human_approved'],
  ['0417', '6e19…b2c0', 'block_fraud_flag'],
  ['0418', 'f3d5…1a8e', 'escalate_l2'],
  ['0419', '08ab…c4f2', 'human_rejected'],
];

const STEPS = [
  ['i', 'Read', 'A template parser reads the invoice first; a model only when the layout is new. Anything read with less than 85% confidence goes to a person, never through.'],
  ['ii', 'Match', 'Rules compare it line by line with the purchase order and with what was actually received: price, quantity, receipt date, currency, tax, unit of measure, lines nobody ordered. Fifteen exception rules, all in one table.'],
  ['iii', 'Review', 'Two AI reviewers from different model families look for what rules cannot see, like a near-duplicate or an odd vendor history. They can only make a decision stricter, never approve one.'],
  ['iv', 'Record', 'A person decides anything unusual. Every step, human or machine, is written to a hash-chained trail where changing one record breaks every link after it.'],
];

const LIMITS = [
  'Payments are simulated. Approved bills post to a real double-entry ledger, but no money moves.',
  'The tolerances come from a written matching spec, not from your company’s own policy. They are one table to change.',
  'Text PDFs only. A scanned invoice is refused with a reason, not guessed at.',
  'The audit trail is tamper-evident, not tamper-proof: it shows that a record changed, not who changed it.',
];

export default function Landing() {
  const auth = useAuth();
  const [justSignedOut] = useState(auth.signedOut);
  const { signedOut, acknowledgeSignedOut } = auth;
  useEffect(() => { if (signedOut) acknowledgeSignedOut(); }, [signedOut, acknowledgeSignedOut]);
  const signedIn = Boolean(auth.user);
  // Sign-in switched off (local development only): there is nothing to log in to.
  const openServer = auth.status === 'ready' && !auth.required;
  const enterLabel = signedIn || openServer ? 'Open the workbench' : 'Log in';
  const enterTo = signedIn || openServer ? '/app' : '/login';

  return (
    <div className="lp-root">
      <div className="lp-paper" aria-hidden="true" />

      <header className="lp-nav">
        <Link to="/" className="lp-brand" aria-label="VeriBook home">
          <span className="vb-brand-mark" aria-hidden="true">V</span>
          <span>VeriBook</span>
        </Link>
        <nav className="lp-nav-links" aria-label="Page">
          <a href="#how">How it decides</a>
          <a href="#limits">What it doesn’t do</a>
        </nav>
        <Link to={enterTo} className="lp-btn lp-btn-solid">
          {signedIn ? <ArrowRight size={16} aria-hidden="true" /> : <LogIn size={16} aria-hidden="true" />}
          {enterLabel}
        </Link>
      </header>

      <main>
        <section className="lp-hero" aria-labelledby="lp-title">
          <div className="lp-hero-copy">
            <p className="lp-eyebrow">Accounts payable, checked before it is paid</p>
            <h1 id="lp-title">
              Every invoice, <em>checked three ways.</em>
            </h1>
            <p className="lp-lede">
              VeriBook holds each invoice up against its purchase order and what was actually delivered.
              Rules make the call, AI can only make it more careful, and a person approves anything unusual.
              Every step lands in a trail that shows if anyone rewrites it.
            </p>
            <div className="lp-cta">
              <Link to={enterTo} className="lp-btn lp-btn-solid lp-btn-lg">{enterLabel} <ArrowRight size={18} aria-hidden="true" /></Link>
              <a href="#how" className="lp-btn lp-btn-ghost lp-btn-lg">See how it decides</a>
            </div>
            {signedIn && <p className="lp-signed">Signed in as <b>{auth.user.name}</b></p>}
            {justSignedOut && !signedIn && <p className="lp-signed" role="status">You have signed out.</p>}
          </div>

          <figure className="lp-match" aria-label="A purchase order, a goods receipt and an invoice line up and are stamped matched">
            {DOCS.map((d, i) => (
              <div key={d.kind} className={`lp-doc lp-doc-${i + 1}`}>
                <div className="lp-doc-head">
                  <span className="lp-doc-kind">{d.kind}</span>
                  <span className="lp-doc-ref">{d.ref}</span>
                </div>
                {d.rows.map(([item, qty, value]) => (
                  <div className="lp-doc-row" key={item}>
                    <span>{item}</span><span>{qty}</span><span>{value}</span>
                  </div>
                ))}
                <div className="lp-doc-note">{d.note}</div>
              </div>
            ))}
            <div className="lp-seal" aria-hidden="true">
              <svg viewBox="0 0 120 120">
                <defs><path id="lp-seal-circle" d="M60 60 m -44 0 a 44 44 0 1 1 88 0 a 44 44 0 1 1 -88 0" /></defs>
                <circle cx="60" cy="60" r="56" />
                <text><textPath href="#lp-seal-circle" startOffset="0">MATCHED · 3 OF 3 · WITHIN TOLERANCE ·</textPath></text>
                <path className="lp-seal-check" d="M44 61 l11 11 l22 -24" />
              </svg>
            </div>
          </figure>
        </section>

        <section className="lp-chain" aria-labelledby="lp-chain-title">
          <h2 id="lp-chain-title" className="lp-visually-hidden">The audit trail</h2>
          <div className="lp-chain-track" aria-hidden="true">
            {[...CHAIN, ...CHAIN].map(([seq, hash, action], i) => (
              <div className="lp-block" key={i}>
                <span className="lp-block-seq">#{seq}</span>
                <span className="lp-block-hash">{hash}</span>
                <span className={`lp-block-action lp-act-${action.split('_')[0]}`}>{action}</span>
              </div>
            ))}
          </div>
          <p className="lp-chain-caption">
            Every decision is hashed into the one before it. Change any record, and every link after it stops matching.
          </p>
        </section>

        <section id="how" className="lp-steps" aria-labelledby="lp-how-title">
          <h2 id="lp-how-title">How a decision is made</h2>
          <ol>
            {STEPS.map(([n, title, body]) => (
              <li key={n}>
                <span className="lp-step-n" aria-hidden="true">{n}.</span>
                <h3>{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="lp-quote" aria-label="The rule VeriBook is built on">
          <blockquote>
            “A model can make a decision more careful.<br /><em>Only rules, and people, can approve one.”</em>
          </blockquote>
          <p>
            A changed vendor bank account stops everything until someone phones the vendor on a number from your own records,
            and a second, different person signs off.
          </p>
        </section>

        <section id="limits" className="lp-limits" aria-labelledby="lp-limits-title">
          <h2 id="lp-limits-title">What it doesn’t do, said plainly</h2>
          <ul>
            {LIMITS.map((l) => <li key={l}>{l}</li>)}
          </ul>
        </section>

        <section className="lp-final">
          <h2>Ready to look at the queue?</h2>
          <Link to={enterTo} className="lp-btn lp-btn-solid lp-btn-lg">{enterLabel} <ArrowRight size={18} aria-hidden="true" /></Link>
        </section>
      </main>

      <footer className="lp-foot">
        <span>VeriBook</span>
        <span>Winner · Track 2 · Syndicate by Maximor</span>
        <a href="https://github.com/devangmishra1424/open-ledger" target="_blank" rel="noreferrer">Source on GitHub</a>
      </footer>
    </div>
  );
}
