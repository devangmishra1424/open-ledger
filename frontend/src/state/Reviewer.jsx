import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useAuth } from './Auth';

/**
 * Who is acting.
 *
 * Signed in: the account's name, fixed. The server records decisions under the signed-in account
 * and ignores any typed name, so "a different person must sign off" compares real accounts.
 *
 * Sign-in off (local development only): the name is self-declared, stored in this browser only,
 * and sent with every human decision so it is recorded in the hash chain. The Settings page says
 * plainly that this is not authentication.
 */
const KEY = 'veribook.reviewer';
const ReviewerContext = createContext(null);

function readStored() {
  try {
    return localStorage.getItem(KEY) || '';
  } catch {
    // Storage can be blocked (private mode, embedded browsers); the name then lasts for this session only.
    return '';
  }
}

export function ReviewerProvider({ children }) {
  const { user } = useAuth();
  const [typedName, setNameState] = useState(readStored);
  const [askOpen, setAskOpen] = useState(false);
  const [pending, setPending] = useState(null);
  const locked = Boolean(user);
  const name = user ? user.name : typedName;

  const setName = useCallback((value) => {
    const trimmed = value.trim().slice(0, 80);
    setNameState(trimmed);
    try {
      localStorage.setItem(KEY, trimmed);
    } catch {
      // See readStored: not being able to persist the name must not break acting as them.
    }
  }, []);

  /** Runs `action(name)` now if a name is set, otherwise asks for one first and then runs it. */
  const withReviewer = useCallback((action) => {
    if (name) return action(name);
    setPending(() => action);
    setAskOpen(true);
    return undefined;
  }, [name]);

  const openNameDialog = useCallback(() => { if (!locked) setAskOpen(true); }, [locked]);

  const confirmName = (value) => {
    if (!value.trim()) return;
    setName(value);
    setAskOpen(false);
    const run = pending;
    setPending(null);
    if (run) run(value.trim().slice(0, 80));
  };

  return (
    <ReviewerContext.Provider value={{ name, locked, setName, withReviewer, openNameDialog }}>
      {children}
      {askOpen && <NameDialog initial={name} onConfirm={confirmName} onCancel={() => { setAskOpen(false); setPending(null); }} />}
    </ReviewerContext.Provider>
  );
}

function NameDialog({ initial, onConfirm, onCancel }) {
  const [value, setValue] = useState(initial || '');
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="vb-modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <form
        className="vb-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vb-name-title"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); onConfirm(value); }}
      >
        <h2 id="vb-name-title">Who is making this decision?</h2>
        <p className="vb-muted">Your name is recorded next to the decision in the audit trail. There is no login yet, so type the name you want on the record.</p>
        <label className="vb-field">
          <span>Your name</span>
          <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} maxLength={80} placeholder="e.g. Priya Shah" />
        </label>
        <div className="vb-modal-actions">
          <button type="button" className="vb-btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="vb-btn vb-btn-primary" disabled={!value.trim()}>Continue</button>
        </div>
      </form>
    </div>
  );
}

export function useReviewer() {
  const ctx = useContext(ReviewerContext);
  if (!ctx) throw new Error('useReviewer must be used inside <ReviewerProvider>');
  return ctx;
}
