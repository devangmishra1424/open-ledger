import React, { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '../services/api';
import { AddPoModal, ReceiptModal } from '../components/PoModals';
import { Banner, Empty, Spinner } from '../components/ui';
import { formatMoney } from '../lib/labels';

function receiptState(po) {
  const received = po.lines.reduce((s, l) => s + l.received, 0);
  if (po.receivedInFull) return { label: 'Received in full', cls: 'vb-chip-approved' };
  if (received > 0) return { label: 'Partly received', cls: 'vb-chip-needs_attention' };
  return { label: 'Nothing received', cls: 'vb-chip-neutral' };
}

/**
 * The other two documents of a three-way match. In a real system procurement and the warehouse create
 * these and the AP system receives them from the ERP; here you can enter them, so an invoice you add
 * afterwards is matched against records you supplied.
 */
export default function PurchaseOrders() {
  const ctx = useOutletContext() ?? {};
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [receiving, setReceiving] = useState(null);

  const load = useCallback(() => {
    api.getPurchaseOrders().then((o) => { setOrders(o); setError(null); }).catch((e) => setError(e));
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <div className="vb-inline" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <p className="vb-muted vb-small" style={{ margin: 0, maxWidth: 640 }}>
          An invoice is checked against a <b>purchase order</b> (what was ordered) and a <b>goods receipt</b> (what actually arrived). In a real company these come from procurement and the warehouse; here you can add them yourself, then add the invoice and watch the three be compared.
        </p>
        <button type="button" className="vb-btn vb-btn-primary" onClick={() => setAdding(true)}><Plus size={16} /> Add PO &amp; receipt</button>
      </div>

      {error && <Banner kind="error">Could not load purchase orders: {error.message}</Banner>}
      {!orders && !error && <Spinner label="Loading…" />}
      {orders && orders.length === 0 && (
        <Empty title="No purchase orders yet" action={<button type="button" className="vb-btn vb-btn-primary" onClick={() => setAdding(true)}>Add the first one</button>}>
          Add a purchase order (and what was received), then add an invoice that refers to its number.
        </Empty>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {(orders ?? []).map((po) => {
          const st = receiptState(po);
          return (
            <section key={po.id} className="vb-card" style={{ padding: 16 }} aria-label={`Purchase order ${po.poNumber}`}>
              <div className="vb-inline" style={{ justifyContent: 'space-between' }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: 15 }}>{po.poNumber} <span className="vb-muted" style={{ fontWeight: 400 }}>&middot; {po.vendor}</span></h3>
                  <div className="vb-dim vb-small">Ordered {po.orderDate} &middot; {formatMoney(po.total, po.currency)} &middot; {po.invoiceCount === 0 ? 'no invoices yet' : `${po.invoiceCount} invoice${po.invoiceCount === 1 ? '' : 's'}`}</div>
                </div>
                <div className="vb-inline">
                  <span className={`vb-chip ${st.cls}`}>{st.label}</span>
                  <button type="button" className="vb-btn vb-btn-sm" onClick={() => setReceiving(po)} disabled={po.status === 'closed'}>Record a receipt</button>
                </div>
              </div>
              <table className="vb-table" style={{ marginTop: 10 }}>
                <thead><tr><th>Line</th><th className="num">Ordered</th><th className="num">Received</th><th className="num">Unit price</th></tr></thead>
                <tbody>
                  {po.lines.map((l) => (
                    <tr key={l.lineNumber}>
                      <td>{l.description}</td>
                      <td className="num">{l.ordered}</td>
                      <td className="num" style={l.received < l.ordered ? { color: 'var(--vb-attention)' } : undefined}>{l.received}</td>
                      <td className="num">{formatMoney(l.unitPrice, po.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          );
        })}
      </div>

      {adding && (
        <AddPoModal
          onClose={() => setAdding(false)}
          onSaved={(opts) => { load(); if (opts?.addInvoice) ctx.openAddInvoice?.(); }}
        />
      )}
      {receiving && <ReceiptModal po={receiving} onClose={() => setReceiving(null)} onSaved={load} />}
    </>
  );
}
