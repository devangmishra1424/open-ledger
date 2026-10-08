import React, { useEffect, useState } from 'react';
import { api } from '../services/api';
import { Banner, Empty, Spinner } from '../components/ui';

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
      <p className="vb-muted" style={{ margin: 0, maxWidth: 720, lineHeight: 1.5 }}>
        Every invoice passes through these steps in order. The numbers come from what the system actually recorded: how many times each step ran, how long it took, how sure it said it was, and how often it failed.
        Confidence is what a step reports about itself. It is not an accuracy score.
      </p>
      <div className="vb-card" style={{ overflowX: 'auto' }}>
        {agents.every((a) => a.totalProcessed === 0) ? (
          <Empty title="Nothing has run yet">Add an invoice and each step will show up here.</Empty>
        ) : (
          <table className="vb-stages">
            <thead>
              <tr><th>Step</th><th>Done by</th><th className="num">Runs</th><th className="num">Avg time</th><th className="num">Reported confidence</th><th className="num">Failed</th></tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id}>
                  <td style={{ maxWidth: 360 }}>
                    <strong>{a.name}</strong>
                    <div className="vb-muted" style={{ fontSize: 13, lineHeight: 1.45, marginTop: 2 }}>{a.description}</div>
                  </td>
                  <td className="vb-mono" style={{ fontSize: 12.5, maxWidth: 220 }}>{a.model}</td>
                  <td className="num">{a.totalProcessed}</td>
                  <td className="num">{a.avgSpeed}</td>
                  <td className="num">{a.avgConfidence != null ? `${a.avgConfidence}%` : '–'}</td>
                  <td className="num" style={{ color: a.errorRate > 0 ? 'var(--vb-danger)' : undefined }}>{a.errorRate != null ? `${a.errorRate}%` : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
