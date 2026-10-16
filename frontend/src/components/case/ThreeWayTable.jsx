import React from 'react';
import { formatMoney } from '../../lib/labels';

const num = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: d });

/** Human wording for each flag the server computed. Colour is never the only signal: every flag is also words. */
function flagText(flag, line) {
  switch (flag) {
    case 'price_over': return { bad: true, text: `Price ${num(line.priceVariancePct * 100, 1)}% above the PO (allowed: ${num(line.tolerancePct * 100, 1)}%)` };
    case 'price_under': return { bad: false, text: `Price ${num(Math.abs(line.priceVariancePct) * 100, 1)}% below the PO` };
    case 'qty_over_received': return { bad: true, text: `Billing for ${num(line.qtyVsReceived)} more than was received` };
    case 'qty_over_ordered': return { bad: true, text: `Billing for ${num(line.invoice.qty - line.qtyOrdered)} more than was ordered (${num(line.qtyOrdered)})` };
    case 'not_received': return { bad: true, text: 'Nothing received yet: billed before delivery' };
    case 'not_invoiced': return { bad: false, text: 'Not on this invoice (a partial invoice is normal)' };
    default: return { bad: false, text: flag };
  }
}

/**
 * The three-way match, visible: for each purchase-order line, what was ordered, what was received
 * (accepted deliveries only) and what the invoice bills, with the differences spelled out.
 */
export default function ThreeWayTable({ threeWay, invoiceCurrency }) {
  if (!threeWay) {
    return (
      <div className="vb-callout">
        <strong>No purchase order on this invoice.</strong> Without one there is nothing to compare the bill against: no agreed price, no agreed quantity, no delivery record. So its price and quantity cannot be checked automatically; a person confirms the spend was authorised.
      </div>
    );
  }
  const cur = threeWay.currency || invoiceCurrency;
  const problems = threeWay.lines.reduce((n, l) => n + l.flags.filter((f) => flagText(f, l).bad).length, 0) + threeWay.unmatchedInvoiceLines.length;

  return (
    <div>
      <p className="vb-3w-intro">
        Purchase order <strong className="vb-mono">{threeWay.poNumber}</strong> ({threeWay.poStatus}{threeWay.poType === 'blanket' ? ', blanket order' : ''}).
        {' '}{problems === 0 ? 'Ordered, received and billed agree on every line.' : `${problems} difference${problems === 1 ? '' : 's'} to look at, marked below.`}
      </p>

      <div className="vb-scroll-x">
        <table className="vb-3w">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col" className="num">Ordered<span>PO price</span></th>
              <th scope="col" className="num">Received<span>accepted</span></th>
              <th scope="col" className="num">Invoiced<span>billed price</span></th>
              <th scope="col">What the check found</th>
            </tr>
          </thead>
          <tbody>
            {threeWay.lines.map((l) => {
              const flags = l.flags.map((f) => ({ f, ...flagText(f, l) }));
              const hasBad = flags.some((x) => x.bad);
              return (
                <tr key={l.poLineId} className={hasBad ? 'vb-3w-bad' : undefined}>
                  <td>
                    <div className="vb-3w-item">{l.description}</div>
                    <div className="vb-dim vb-3w-sub">PO line {l.lineNumber} · per {l.uom}</div>
                  </td>
                  <td className="num"><b>{num(l.qtyOrdered)}</b><span>@ {num(l.unitPrice)}</span></td>
                  <td className="num"><b>{num(l.qtyReceived)}</b></td>
                  <td className="num">
                    {l.invoice ? <><b>{num(l.invoice.qty)}</b><span>@ {num(l.invoice.unitPrice)}</span></> : <span className="vb-dim">&mdash;</span>}
                  </td>
                  <td>
                    {flags.length === 0
                      ? <span className="vb-3w-ok">Matches</span>
                      : flags.map((x) => <div key={x.f} className={x.bad ? 'vb-3w-flag-bad' : 'vb-3w-flag-note'}>{x.text}</div>)}
                  </td>
                </tr>
              );
            })}
            {threeWay.unmatchedInvoiceLines.map((l, i) => (
              <tr key={`u${i}`} className="vb-3w-bad">
                <td><div className="vb-3w-item">{l.description}</div><div className="vb-dim vb-3w-sub">On the invoice only</div></td>
                <td className="num"><span className="vb-dim">&mdash;</span></td>
                <td className="num"><span className="vb-dim">&mdash;</span></td>
                <td className="num"><b>{num(l.qty)}</b><span>@ {num(l.unitPrice)}</span></td>
                <td><div className="vb-3w-flag-bad">No matching line on the purchase order</div></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Totals (at PO prices for ordered and received)</th>
              <td className="num"><b>{formatMoney(threeWay.totals.ordered, cur)}</b></td>
              <td className="num"><b>{formatMoney(threeWay.totals.received, cur)}</b></td>
              <td className="num"><b>{formatMoney(threeWay.totals.invoiced, cur)}</b><span>before tax</span></td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      {threeWay.ceiling != null && (
        <p className="vb-3w-note">Blanket order ceiling: <b className="vb-mono">{formatMoney(threeWay.ceiling, cur)}</b>.</p>
      )}

      <div className="vb-3w-deliveries">
        <span className="vb-dim">Deliveries:</span>{' '}
        {threeWay.receipts.length === 0
          ? <b>none recorded</b>
          : threeWay.receipts.map((r, i) => (
              <span key={i} className={`vb-chip ${r.condition === 'accepted' ? 'vb-chip-neutral' : 'vb-chip-rejected'}`} style={{ marginRight: 6 }}>
                {r.date} · {r.condition}{r.receiver ? ` · ${r.receiver}` : ''}{r.finalDelivery ? ' · final' : ''}
              </span>
            ))}
      </div>
    </div>
  );
}
