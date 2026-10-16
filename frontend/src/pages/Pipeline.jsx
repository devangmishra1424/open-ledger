import React, { useEffect, useState } from 'react';
import { api } from '../services/api';
import { Banner, Empty, Spinner } from '../components/ui';
import { STAGE_GUIDE, KIND_LABEL } from '../lib/stageGuide';

/** What this step's own numbers say, in a sentence: read from the figures, never assumed. */
function reading(a) {
  if (a.totalProcessed === 0) {
    return a.id === 'verify'
      ? 'Has not run yet: it only runs on serious cases (a level 2 review or a block), so a quiet count here is normal.'
      : 'Has not run yet.';
  }
  const parts = [`Ran ${a.totalProcessed} time${a.totalProcessed === 1 ? '' : 's'}.`];
  if (a.errorRate > 0) parts.push(`Failed on ${a.errorRate}% of runs; each failure held that invoice for a person instead of guessing. AI failures are most often a provider's free-tier limit.`);
  else parts.push('Never failed.');
  if (a.avgConfidence != null) parts.push(`On average it reported itself ${a.avgConfidence}% sure (what it says about itself, not a measured accuracy).`);
  return parts.join(' ');
}

/** One row per automated step, from the decisions the system has actually recorded. */
export default function Pipeline() {
  const [agents, setAgents] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = () => api.getAgents().then((a) => { if (alive) { setAgents(a); setError(null); } }).catch((e) => alive && setError(e));
    load();
    const t = setInterval(load, 30000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (error && !agents) return <Banner kind="error">Could not load the pipeline: {error.message}</Banner>;
  if (!agents) return <Spinner label="Loading…" />;

  return (
    <div className="vb-page">
      <div className="vb-card vb-pad vb-intro">
        <p>
          Every invoice passes through these seven steps, top to bottom. <b>Rules</b> steps are fixed code: the same invoice always gets the same answer.
          {' '}<b>AI</b> steps recommend and explain, and can only make an outcome stricter, never approve something a rule flagged.
          The figures are counted from what the system actually recorded, refreshed every 30 seconds.
        </p>
        <dl className="vb-legend-dl">
          <div><dt>Done by</dt><dd>The engine or the AI model configured for that step right now.</dd></div>
          <div><dt>Runs</dt><dd>How many times the step has run, across all invoices.</dd></div>
          <div><dt>Avg time</dt><dd>Measured from start to finish of the step.</dd></div>
          <div><dt>Reported confidence</dt><dd>How sure the step said it was. Not an accuracy score.</dd></div>
          <div><dt>Failed</dt><dd>Share of runs that ended in an error. A failure never guesses: the invoice waits for a person.</dd></div>
        </dl>
      </div>
      <div className="vb-card" style={{ overflowX: 'auto' }}>
        {agents.every((a) => a.totalProcessed === 0) ? (
          <Empty title="Nothing has run yet">Add an invoice and each step will show up here.</Empty>
        ) : (
          <table className="vb-stages">
            <thead>
              <tr><th>Step</th><th>Done by</th><th className="num">Runs</th><th className="num">Avg time</th><th className="num">Reported confidence</th><th className="num">Failed</th></tr>
            </thead>
            <tbody>
              {agents.map((a, i) => {
                const g = STAGE_GUIDE[a.id];
                const kind = g ? KIND_LABEL[g.kind] : null;
                return (
                  <tr key={a.id}>
                    <td style={{ maxWidth: 420 }}>
                      <strong>{i + 1}. {g?.name ?? a.name}</strong>
                      {kind && <span className={`vb-kind vb-kind-${g.kind}`} title={kind.title}>{kind.label}</span>}
                      <div className="vb-muted" style={{ fontSize: 13, lineHeight: 1.45, marginTop: 4 }}>{g?.what ?? a.description}</div>
                      {g && <div className="vb-dim" style={{ fontSize: 12.5, lineHeight: 1.45, marginTop: 4 }}><b>Why:</b> {g.why} <b>When:</b> {g.when}</div>}
                      <div className="vb-pipe-reading">{reading(a)}</div>
                    </td>
                    <td className="vb-mono" style={{ fontSize: 12.5, maxWidth: 220 }}>{a.model}</td>
                    <td className="num">{a.totalProcessed}</td>
                    <td className="num">{a.avgSpeed}</td>
                    <td className="num">{a.avgConfidence != null ? `${a.avgConfidence}%` : '–'}</td>
                    <td className="num" style={{ color: a.errorRate > 0 ? 'var(--vb-danger)' : undefined }}>{a.errorRate != null ? `${a.errorRate}%` : '–'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
