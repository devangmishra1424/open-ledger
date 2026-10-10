import React from 'react';
import { STATE_LABEL } from '../lib/labels';

export function StateChip({ state }) {
  return <span className={`vb-chip vb-chip-${state}`}>{STATE_LABEL[state] ?? state}</span>;
}

export function Spinner({ label }) {
  return (
    <span role="status" aria-live="polite" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span className="vb-spinner" aria-hidden="true" />
      {label && <span>{label}</span>}
    </span>
  );
}

export function Banner({ kind = 'info', children, action }) {
  return (
    <div className={`vb-banner vb-banner-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div style={{ flex: 1 }}>{children}</div>
      {action}
    </div>
  );
}

export function Empty({ title, children, action }) {
  return (
    <div className="vb-empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/** Initials for the "acting as" avatar. */
export function initials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}
