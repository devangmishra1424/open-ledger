import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../services/api';

/**
 * The one shared copy of the invoice list. The inbox, the detail panel and the sidebar counts all
 * read it, so they cannot disagree; actions patch the returned invoice straight in; and it polls
 * quickly while anything is processing and slowly otherwise.
 */
const InvoicesContext = createContext(null);
const FAST_MS = 4000;
const SLOW_MS = 20000;

export function InvoicesProvider({ children }) {
  const [invoices, setInvoices] = useState(null); // null = not loaded yet
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getInvoices();
      if (!alive.current) return;
      setInvoices(data);
      setError(null);
    } catch (e) {
      if (alive.current) setError(e);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  const patch = useCallback((invoice) => {
    if (!invoice?.id) return;
    setInvoices((list) => {
      if (!list) return [invoice];
      return list.some((i) => i.id === invoice.id) ? list.map((i) => (i.id === invoice.id ? invoice : i)) : [invoice, ...list];
    });
  }, []);

  const anyProcessing = invoices?.some((i) => i.state === 'processing') ?? false;

  useEffect(() => {
    alive.current = true;
    refresh();
    return () => { alive.current = false; };
  }, [refresh]);

  useEffect(() => {
    clearInterval(timer.current);
    timer.current = setInterval(() => { if (!document.hidden) refresh(); }, anyProcessing ? FAST_MS : SLOW_MS);
    return () => clearInterval(timer.current);
  }, [anyProcessing, refresh]);

  const counts = useMemo(() => {
    const c = { needs_attention: 0, processing: 0, approved: 0, paid: 0, rejected: 0, all: 0 };
    for (const i of invoices ?? []) { c[i.state] += 1; c.all += 1; }
    return c;
  }, [invoices]);

  return (
    <InvoicesContext.Provider value={{ invoices, error, loading, refresh, patch, counts }}>
      {children}
    </InvoicesContext.Provider>
  );
}

export function useInvoices() {
  const ctx = useContext(InvoicesContext);
  if (!ctx) throw new Error('useInvoices must be used inside <InvoicesProvider>');
  return ctx;
}
