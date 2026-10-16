import React from 'react';
import { SAYS } from '../../lib/mismatch';

/**
 * What does not match on this invoice, finding by finding: a plain title, then each figure with who says it
 * (the invoice, the purchase order, the delivery, your records) and the gap. The figures that are wrong are
 * marked, so the eye lands on exactly what is off. The rule that decides what happens is the last line.
 */
export default function WhatsWrong({ mismatches }) {
  return (
    <div className="vb-ww">
      {mismatches.map((m, i) => {
        const figures = m.points.filter((p) => p.source !== 'rule');
        const rules = m.points.filter((p) => p.source === 'rule');
        return (
          <section key={`${m.code}-${i}`} className="vb-ww-item" aria-label={m.title}>
            <h4>{m.title}</h4>
            {figures.length > 0 ? (
              <ul className="vb-ww-points">
                {figures.map((p, j) => (
                  <li key={j} className={`vb-ww-pt${p.wrong ? ' is-wrong' : ''}${p.source === 'difference' ? ' is-gap' : ''}`}>
                    <span className={`vb-ww-says vb-ww-says-${p.source}`}>{SAYS[p.source]}</span>
                    <span className="vb-ww-label">{p.label}</span>
                    <span className="vb-ww-value">{p.wrong ? <mark className="vb-wrong">{p.value}</mark> : p.value}</span>
                  </li>
                ))}
              </ul>
            ) : (
              m.text && <p className="vb-ww-text">{m.text}</p>
            )}
            {rules.map((r, j) => <p key={j} className="vb-ww-rule"><b>{r.label}:</b> {r.value}</p>)}
            {m.source === 'worked_out' && (
              <p className="vb-ww-note">Worked out from the order comparison below: this invoice was checked before these figures were recorded with it.</p>
            )}
          </section>
        );
      })}
    </div>
  );
}
