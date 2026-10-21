import React, { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '../services/api';
import { AddPoModal, ReceiptModal } from '../components/PoModals';
import { Banner, Empty, Spinner } from '../components/ui';
import { formatMoney } from '../lib/labels';
import { useReviewer } from '../state/Reviewer';
import { useToasts } from '../state/Toasts';

function receiptState(po) {
  const received = po.lines.reduce((s, l) => s + l.received, 0);
  if (po.receivedInFull) return { label: 'Received in full', cls: 'vb-chip-approved', title: 'Every line has arrived in good condition, so an invoice for the whole order can match.' };
  if (received > 0) return { label: 'Partly received', cls: 'vb-chip-needs_attention', title: 'Some of the order has arrived. Billing for more than has arrived is flagged as a quantity variance.' };
  return { label: 'Nothing received', cls: 'vb-chip-neutral', title: 'Nothing has arrived yet. An invoice against this order is held as billed before receipt until a receipt is recorded.' };
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
  const { withReviewer } = useReviewer();
  const toast = useToasts();

  /** A delivery recorded by mistake: removed, then the PO's waiting invoices are checked again. */
  const removeReceipt = (po, r) => withReviewer(async (name) => {
    if (!window.confirm(`Remove the delivery of ${r.date} (${r.units} units, ${r.condition}) from ${po.poNumber}? Those goods stop counting as received.`)) return;
    try {
      const res = await api.removeReceipt(po.id, r.id, name);
      const n = res.recheckedInvoices?.length ?? 0;
      toast.success(`Delivery removed from ${po.poNumber}.${n ? ` ${n} waiting invoice${n === 1 ? ' is' : 's are'} being checked again.` : ''}`);
      load();
    } catch (e) {
      toast.error(e.message);
    }
  });

  const load = useCallback(() => {
    api.getPurchaseOrders().then((o) => { setOrders(o); setError(null); }).catch((e) => setError(e));
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <div className="vb-inline" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <p className="vb-muted vb-small" style={{ margin: 0, maxWidth: 640 }}>
          An invoice is checked against a <b>purchase order</b> (what was ordered, at what price) and a <b>goods receipt</b> (what actually arrived, in good condition). In a real company these come from procurement and the warehouse; here you can add them yourself, then add an invoice that quotes the PO number and watch the three be compared. <b>Recording a receipt re-checks any invoice already waiting on that order.</b>
        </p>
        <button type="button" className="vb-btn vb-btn-primary" onClick={() => setAdding(true)} title="Create a purchase order, and optionally what was received against it, so the next invoice you add has something to be matched against."><Plus size={16} /> Add PO &amp; receipt</button>
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
                  {po.spendingLimit != null && <div className="vb-small" style={{ marginTop: 2 }}>Blanket order: all its invoices together may come to at most <b>{formatMoney(po.spendingLimit, po.currency)}</b></div>}
                </div>
                <div className="vb-inline">
                  <span className={`vb-chip ${st.cls}`} title={st.title}>{st.label}</span>
                  <button type="button" className="vb-btn vb-btn-sm" onClick={() => setReceiving(po)} disabled={po.status === 'closed'}
                    title={po.status === 'closed' ? 'This order is closed: nothing more can be received or billed against it.' : 'Record goods that arrived against this order, as the warehouse would. Any invoice waiting on this order is checked again on its own.'}>Record a receipt</button>
                </div>
              </div>
              <table className="vb-table" style={{ marginTop: 10 }}>
                <thead><tr><th>Line</th><th className="num">Ordered</th><th className="num" title="Accepted into the warehouse in good condition; damaged or rejected goods do not count">Received</th><th className="num" title="The agreed price an invoice line is compared with (2% difference is tolerated)">Unit price</th></tr></thead>
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
              {po.receipts.length > 0 && (
                <div className="vb-small" style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  <span className="vb-dim">Deliveries recorded:</span>
                  {po.receipts.map((r) => (
                    <span key={r.id} className={`vb-chip ${r.condition === 'accepted' ? 'vb-chip-neutral' : 'vb-chip-rejected'}`}>
                      {r.date} · {r.units} units · {r.condition}{r.receiver ? ` · ${r.receiver}` : ''}
                      {' '}<button type="button" className="vb-link-btn" onClick={() => removeReceipt(po, r)} title="Recorded by mistake? Remove it; the goods stop counting as received and waiting invoices are checked again.">remove</button>
                    </span>
                  ))}
                </div>
              )}
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
