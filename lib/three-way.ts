import { matchLines, type InvoiceLineInput, type PoLineInput } from "@/lib/matching/line-match";

/**
 * The three-way comparison a reviewer actually wants to see: for every purchase-order line, what
 * was ORDERED, what was RECEIVED (accepted deliveries only, the same rule the matching engine
 * counts by) and what the invoice BILLS, side by side, with the differences flagged.
 *
 * Invoice lines are paired to PO lines by the engine's own matcher (lib/matching/line-match.ts),
 * so what is shown here is the pairing the engine works from, not a second opinion about it.
 * Pure: everything it needs is passed in, so it is tested without a database.
 */

export type ThreeWayFlag =
  | "price_over"          // billed above the PO price by more than the line's tolerance
  | "price_under"         // billed below the PO price by more than the line's tolerance
  | "qty_over_received"   // billing for more than was accepted into the warehouse
  | "qty_over_ordered"    // billing for more than was ordered
  | "not_received"        // billed, but nothing accepted yet
  | "not_invoiced";       // on the PO, not on this invoice (often fine: a partial invoice)

export interface ThreeWayLine {
  poLineId: string;
  lineNumber: number;
  description: string;
  uom: string;
  qtyOrdered: number;
  unitPrice: number;
  tolerancePct: number;
  /** Accepted deliveries only (damaged / rejected receipts are not counted). */
  qtyReceived: number;
  invoice: { description: string; uom: string; qty: number; unitPrice: number; amount: number } | null;
  priceVariancePct: number | null;
  /** invoiced qty minus accepted-received qty; positive = billing for goods not received. */
  qtyVsReceived: number | null;
  flags: ThreeWayFlag[];
}

export interface ThreeWay {
  poNumber: string;
  poStatus: string;
  poType: string;
  currency: string;
  /** Blanket POs: the negotiated ceiling, if any. */
  ceiling: number | null;
  lines: ThreeWayLine[];
  /** Invoice lines the matcher could not pair with any PO line. */
  unmatchedInvoiceLines: Array<{ description: string; uom: string; qty: number; unitPrice: number; amount: number }>;
  receipts: Array<{ date: string; receiver: string | null; condition: string; finalDelivery: boolean }>;
  totals: { ordered: number; received: number; invoiced: number };
}

export interface ThreeWayInput {
  po: { po_number: string; status: string; po_type: string; currency: string; max_value_ceiling: number | null };
  poLines: Array<{ id: string; line_number: number; description: string; uom: string; qty_ordered: number; unit_price: number; tolerance_pct: number }>;
  receipts: Array<{ id: string; receipt_date: string; receiver_name: string | null; condition: string; final_delivery_indicator: boolean }>;
  receiptLines: Array<{ goods_receipt_id: string; po_line_id: string; qty_received: number }>;
  billLines: Array<{ id: string; description: string; uom: string; qty_invoiced: number; unit_price: number }>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function buildThreeWay(input: ThreeWayInput): ThreeWay {
  const { po, poLines, receipts, receiptLines, billLines } = input;

  const accepted = new Set(receipts.filter((r) => r.condition === "accepted").map((r) => r.id));
  const receivedByLine = new Map<string, number>();
  for (const rl of receiptLines) {
    if (accepted.has(rl.goods_receipt_id)) receivedByLine.set(rl.po_line_id, (receivedByLine.get(rl.po_line_id) ?? 0) + Number(rl.qty_received));
  }

  const invoiceInputs: InvoiceLineInput[] = billLines.map((l) => ({ id: l.id, description: l.description, uom: l.uom, qty: Number(l.qty_invoiced), unitPrice: Number(l.unit_price) }));
  const poInputs: PoLineInput[] = poLines.map((l) => ({ id: l.id, lineNumber: l.line_number, description: l.description, uom: l.uom, qtyOrdered: Number(l.qty_ordered), unitPrice: Number(l.unit_price) }));
  const report = matchLines(invoiceInputs, poInputs);
  const pairedInvoice = new Map(report.matched.map((m) => [m.poLineId, m.invoiceLineId]));
  const billById = new Map(billLines.map((l) => [l.id, l]));

  const lines: ThreeWayLine[] = poLines.map((pl) => {
    const qtyOrdered = Number(pl.qty_ordered);
    const unitPrice = Number(pl.unit_price);
    const tolerancePct = Number(pl.tolerance_pct);
    const qtyReceived = receivedByLine.get(pl.id) ?? 0;
    const billed = billById.get(pairedInvoice.get(pl.id) ?? "");
    const invoice = billed
      ? { description: billed.description, uom: billed.uom, qty: Number(billed.qty_invoiced), unitPrice: Number(billed.unit_price), amount: round2(Number(billed.qty_invoiced) * Number(billed.unit_price)) }
      : null;

    const flags: ThreeWayFlag[] = [];
    let priceVariancePct: number | null = null;
    let qtyVsReceived: number | null = null;
    if (!invoice) {
      flags.push("not_invoiced");
    } else {
      priceVariancePct = unitPrice === 0 ? (invoice.unitPrice === 0 ? 0 : Infinity) : (invoice.unitPrice - unitPrice) / unitPrice;
      if (priceVariancePct > tolerancePct) flags.push("price_over");
      else if (priceVariancePct < -tolerancePct) flags.push("price_under");
      qtyVsReceived = invoice.qty - qtyReceived;
      if (qtyReceived === 0) flags.push("not_received");
      else if (qtyVsReceived > 0) flags.push("qty_over_received");
      if (invoice.qty > qtyOrdered) flags.push("qty_over_ordered");
    }
    return {
      poLineId: pl.id, lineNumber: pl.line_number, description: pl.description, uom: pl.uom,
      qtyOrdered, unitPrice, tolerancePct, qtyReceived, invoice,
      priceVariancePct: priceVariancePct === null || !Number.isFinite(priceVariancePct) ? priceVariancePct : Math.round(priceVariancePct * 10000) / 10000,
      qtyVsReceived, flags,
    };
  }).sort((a, b) => a.lineNumber - b.lineNumber);

  const unmatchedInvoiceLines = report.unmatchedInvoiceLines.map((u) => {
    const l = billById.get(u.invoiceLineId)!;
    return { description: l.description, uom: l.uom, qty: Number(l.qty_invoiced), unitPrice: Number(l.unit_price), amount: round2(Number(l.qty_invoiced) * Number(l.unit_price)) };
  });

  return {
    poNumber: po.po_number,
    poStatus: po.status,
    poType: po.po_type,
    currency: po.currency,
    ceiling: po.max_value_ceiling == null ? null : Number(po.max_value_ceiling),
    lines,
    unmatchedInvoiceLines,
    receipts: receipts.map((r) => ({ date: r.receipt_date, receiver: r.receiver_name, condition: r.condition, finalDelivery: Boolean(r.final_delivery_indicator) })),
    totals: {
      ordered: round2(lines.reduce((s, l) => s + l.qtyOrdered * l.unitPrice, 0)),
      received: round2(lines.reduce((s, l) => s + l.qtyReceived * l.unitPrice, 0)),
      invoiced: round2(billLines.reduce((s, l) => s + Number(l.qty_invoiced) * Number(l.unit_price), 0)),
    },
  };
}
