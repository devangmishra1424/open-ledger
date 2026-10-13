import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { api } from '../../services/api';
import { useInvoices } from '../../state/Invoices';
import { useReviewer } from '../../state/Reviewer';
import { useToasts } from '../../state/Toasts';
import { Banner, Spinner } from '../ui';

/**
 * "Check it again": for an invoice waiting for a person after its purchase order or goods receipt changed. An invoice
 * is matched when it is saved; adding its PO later, or recording the goods later, re-checks it on its own (Orders),
 * and this does the same by hand, or links a PO the invoice did not print. Shown only while the invoice waits for a
 * person (lib/pipeline/recheck.ts).
 */
export default function Recheck({ invoice }) {
  const { withReviewer } = useReviewer();
  const { refresh } = useInvoices();
  const toast = useToasts();
  const nonPo = !invoice.poNumber || invoice.poNumber === 'Non-PO';
  const [poNumber, setPoNumber] = useState(invoice.poReference ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (invoice.rawStatus !== 'exception') return null;

  const run = () => withReviewer(async (name) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.recheckInvoice(invoice.id, name, nonPo ? poNumber.trim() || undefined : undefined);
      toast.success(r.message);
      refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  });

  return (
    <section className="vb-card vb-aside-card">
      <h2>Check it again</h2>
      {nonPo ? (
        <>
          <p className="vb-small vb-muted" style={{ marginTop: 0 }}>
            {invoice.poReference
              ? <>When this was saved, purchase order <b>{invoice.poReference}</b> was not on file for {invoice.vendor}.</>
              : <>This invoice prints no PO number, so it was checked as a non-PO invoice.</>}
            {' '}If the PO has been added since (<Link to="/app/orders">Orders</Link>), check again: it is linked (same vendor, same PO number) and the whole check runs again.
          </p>
          <label className="vb-field" style={{ marginBottom: 10 }}>
            <span>PO number</span>
            <input value={poNumber} onChange={(e) => setPoNumber(e.target.value)} placeholder="PO-2026-0871" maxLength={60} />
          </label>
        </>
      ) : (
        <p className="vb-small vb-muted" style={{ marginTop: 0 }}>
          Checked against purchase order <b>{invoice.poNumber}</b>. If that PO changed or goods have arrived since, check again.
          Recording a receipt on <Link to="/app/orders">Orders</Link> does this on its own.
        </p>
      )}
      {error && <Banner kind="error">{error}</Banner>}
      <button type="button" className="vb-btn vb-btn-sm" onClick={run} disabled={busy}>
        {busy ? <Spinner label="Starting…" /> : <><RefreshCw size={14} aria-hidden="true" /> {nonPo && poNumber.trim() ? 'Link the PO and check again' : 'Check again'}</>}
      </button>
    </section>
  );
}
