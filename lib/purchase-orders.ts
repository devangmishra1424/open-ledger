import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { getSql } from "@/db/client";
import { HttpError } from "@/lib/http";
import { findOrCreateVendor } from "@/lib/bills";

/**
 * Purchase orders and goods receipts: the other two documents of a three-way match.
 *
 * In a real AP system they are not uploaded by the AP clerk. Procurement creates the PO before
 * anything is ordered and the warehouse records the receipt when goods arrive; the AP system
 * receives both by sync from the ERP. This project has no ERP, so they come from the seed script,
 * and from here: the same two records, entered by hand (or read from a PO document) so a person can
 * bring their own and watch the invoice matched against them.
 *
 * Writes are single transactions. A PO number is unique, so submitting the same PO twice is a 409,
 * not a second PO. A receipt is not naturally idempotent (the same delivery recorded twice would
 * double the goods received and let an over-bill through), so an identical receipt is refused too.
 */

export type ReceiptCondition = "accepted" | "damaged" | "rejected";
const CONDITIONS: ReceiptCondition[] = ["accepted", "damaged", "rejected"];

export interface NewPoLine { description: string; quantity: number; unitPrice: number; uom?: string | null }
export interface NewReceipt {
  /** Every line received at its ordered quantity. Ignored when `lines` is given. */
  inFull?: boolean;
  /** Per-line quantities received, by PO line number. */
  lines?: Array<{ lineNumber: number; quantity: number }>;
  receiptDate?: string | null;
  receiverName?: string | null;
  condition?: ReceiptCondition | null;
}
export interface NewPoInput {
  vendorId?: string;
  vendorName?: string;
  poNumber: string;
  orderDate?: string | null;
  currency?: string | null;
  buyerName?: string | null;
  lines: NewPoLine[];
  /** Optionally record the goods receipt in the same transaction. */
  receipt?: NewReceipt | null;
  /** The uploaded PO document this was read from (source_documents.id); checked by the caller. */
  sourceDocumentId?: string | null;
}

export interface CreatedPo { poId: string; poNumber: string; vendorId: string; vendorCreated: boolean; receiptId: string | null }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
const MAX_LINES = 200;
const MAX_QTY = 1_000_000_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

function finite(v: unknown, label: string, opts: { min?: number; exclusiveMin?: number } = {}): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new HttpError(400, `${label} must be a number`);
  if (opts.min !== undefined && v < opts.min) throw new HttpError(400, `${label} must be at least ${opts.min}`);
  if (opts.exclusiveMin !== undefined && v <= opts.exclusiveMin) throw new HttpError(400, `${label} must be greater than ${opts.exclusiveMin}`);
  if (v > MAX_QTY) throw new HttpError(400, `${label} is too large`);
  return v;
}

function isoDate(v: string | null | undefined, label: string, today: string): string {
  const d = v ?? today;
  if (!ISO_DATE.test(d) || Number.isNaN(Date.parse(d))) throw new HttpError(400, `${label} must be a real date as YYYY-MM-DD`);
  return d;
}

/** Validates a PO and returns the normalized values; throws HttpError 400. Pure: exported for tests. */
export function normalizePurchaseOrder(input: NewPoInput, today = new Date().toISOString().slice(0, 10)) {
  const poNumber = typeof input.poNumber === "string" ? input.poNumber.trim() : "";
  if (!poNumber) throw new HttpError(400, "the purchase order needs a number");
  if (poNumber.length > 60) throw new HttpError(400, "the PO number is too long (max 60 characters)");
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new HttpError(400, "a purchase order needs at least one line");
  if (input.lines.length > MAX_LINES) throw new HttpError(400, `too many lines (max ${MAX_LINES})`);

  const lines = input.lines.map((l, i) => {
    const description = typeof l?.description === "string" ? l.description.trim() : "";
    if (!description) throw new HttpError(400, `line ${i + 1}: description is required`);
    const uom = typeof l.uom === "string" && l.uom.trim() ? l.uom.trim().toLowerCase() : "each";
    if (uom.length > 20) throw new HttpError(400, `line ${i + 1}: unit of measure is too long`);
    return {
      lineNumber: i + 1,
      description: description.slice(0, 500),
      uom,
      quantity: round4(finite(l.quantity, `line ${i + 1}: quantity`, { exclusiveMin: 0 })),
      unitPrice: round4(finite(l.unitPrice, `line ${i + 1}: unit price`, { min: 0 })),
    };
  });

  const currency = (input.currency ?? "USD").toUpperCase();
  if (!CURRENCY.test(currency)) throw new HttpError(400, "currency must be a 3-letter code such as USD");
  const buyerName = typeof input.buyerName === "string" && input.buyerName.trim() ? input.buyerName.trim().slice(0, 80) : null;

  return {
    poNumber,
    orderDate: isoDate(input.orderDate, "orderDate", today),
    currency,
    buyerName,
    lines,
    total: round2(lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0)),
  };
}

/** Validates a receipt against the PO's lines ({lineNumber, quantity ordered}); throws HttpError 400. Pure: exported for tests. */
export function normalizeReceipt(receipt: NewReceipt, poLines: Array<{ lineNumber: number; quantity: number }>, today = new Date().toISOString().slice(0, 10)) {
  let lines: Array<{ lineNumber: number; quantity: number }>;
  if (Array.isArray(receipt.lines) && receipt.lines.length > 0) {
    const seen = new Set<number>();
    lines = receipt.lines.map((l, i) => {
      if (!Number.isInteger(l?.lineNumber) || !poLines.some((p) => p.lineNumber === l.lineNumber)) {
        throw new HttpError(400, `receipt line ${i + 1}: there is no PO line ${String(l?.lineNumber)} (this PO has lines 1-${poLines.length})`);
      }
      if (seen.has(l.lineNumber)) throw new HttpError(400, `receipt line ${i + 1}: PO line ${l.lineNumber} appears twice`);
      seen.add(l.lineNumber);
      return { lineNumber: l.lineNumber, quantity: round4(finite(l.quantity, `receipt line ${i + 1}: quantity`, { exclusiveMin: 0 })) };
    });
  } else if (receipt.inFull) {
    lines = poLines.map((p) => ({ lineNumber: p.lineNumber, quantity: p.quantity }));
  } else {
    throw new HttpError(400, "say what was received: either receivedInFull, or the quantity for each line");
  }

  const condition = receipt.condition ?? "accepted";
  if (!CONDITIONS.includes(condition)) throw new HttpError(400, `condition must be one of ${CONDITIONS.join(", ")}`);
  const receiverName = typeof receipt.receiverName === "string" && receipt.receiverName.trim() ? receipt.receiverName.trim().slice(0, 80) : null;
  return { lines, condition, receiverName, receiptDate: isoDate(receipt.receiptDate, "receiptDate", today) };
}

/** The receipt part of a JSON request body → NewReceipt. Types are checked here; values (ranges, dates, line numbers) by normalizeReceipt. */
export function receiptFromBody(raw: unknown): NewReceipt {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "receipt must be an object");
  const r = raw as Record<string, unknown>;
  if (r.lines !== undefined && !Array.isArray(r.lines)) throw new HttpError(400, "receipt lines must be an array of { line, qty }");
  return {
    inFull: r.receivedInFull === true,
    lines: Array.isArray(r.lines) ? r.lines.map((l: any) => ({ lineNumber: l?.line, quantity: l?.qty })) : undefined,
    receiptDate: typeof r.receiptDate === "string" ? r.receiptDate : null,
    receiverName: typeof r.receiverName === "string" ? r.receiverName : null,
    condition: typeof r.condition === "string" ? (r.condition as ReceiptCondition) : null,
  };
}

type Tx = TransactionSql;

async function insertReceipt(
  tx: Tx, poId: string, lineIdByNumber: Map<number, string>,
  n: { lines: Array<{ lineNumber: number; quantity: number }>; condition: ReceiptCondition; receiverName: string | null; receiptDate: string },
): Promise<string> {
  const receiptId = randomUUID();
  await tx`
    INSERT INTO goods_receipts (id, po_id, receipt_date, receiver_name, condition, final_delivery_indicator)
    VALUES (${receiptId}, ${poId}, ${n.receiptDate}, ${n.receiverName}, ${n.condition}, false)`;
  for (const l of n.lines) {
    await tx`
      INSERT INTO goods_receipt_lines (id, goods_receipt_id, po_line_id, qty_received)
      VALUES (${randomUUID()}, ${receiptId}, ${lineIdByNumber.get(l.lineNumber)!}, ${l.quantity})`;
  }
  return receiptId;
}

const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";

export async function createPurchaseOrder(input: NewPoInput): Promise<CreatedPo> {
  const n = normalizePurchaseOrder(input);
  const receiptInput = input.receipt ?? null;
  const receipt = receiptInput ? normalizeReceipt(receiptInput, n.lines.map((l) => ({ lineNumber: l.lineNumber, quantity: l.quantity }))) : null;
  const sql = getSql();

  try {
    return await sql.begin(async (tx) => {
      const { vendorId, vendorCreated } = await findOrCreateVendor(tx, input);

      const dup = await tx`SELECT id FROM purchase_orders WHERE po_number = ${n.poNumber}`;
      if (dup.length > 0) throw new HttpError(409, `a purchase order numbered ${n.poNumber} already exists`);

      const glRows = await tx`SELECT id FROM chart_of_accounts WHERE account_number = '6000'`;
      const gl: string | null = glRows[0]?.id ?? null;

      const poId = randomUUID();
      await tx`
        INSERT INTO purchase_orders (id, po_number, vendor_id, buyer_name, order_date, status, po_type, currency, exchange_rate, source_document_id)
        VALUES (${poId}, ${n.poNumber}, ${vendorId}, ${n.buyerName}, ${n.orderDate}, 'open', 'standard', ${n.currency}, 1.0, ${input.sourceDocumentId ?? null})`;
      const lineIdByNumber = new Map<number, string>();
      for (const l of n.lines) {
        const id = randomUUID();
        lineIdByNumber.set(l.lineNumber, id);
        await tx`
          INSERT INTO purchase_order_lines (id, po_id, line_number, description, uom, qty_ordered, unit_price, gl_account_id)
          VALUES (${id}, ${poId}, ${l.lineNumber}, ${l.description}, ${l.uom}, ${l.quantity}, ${l.unitPrice}, ${gl})`;
      }
      const receiptId = receipt ? await insertReceipt(tx, poId, lineIdByNumber, receipt) : null;
      return { poId, poNumber: n.poNumber, vendorId, vendorCreated, receiptId };
    });
  } catch (e) {
    // Two requests racing past the check above: the unique constraint is the real guard.
    if (isUniqueViolation(e)) throw new HttpError(409, `a purchase order numbered ${n.poNumber} already exists`);
    throw e;
  }
}

export async function recordReceipt(poId: string, input: NewReceipt): Promise<{ receiptId: string; poNumber: string; receiptDate: string; condition: ReceiptCondition }> {
  const sql = getSql();
  return sql.begin(async (tx) => {
    // Receipts for one PO are serialized, so two identical submissions cannot both pass the duplicate check below.
    const po = (await tx`SELECT id, po_number, status FROM purchase_orders WHERE id = ${poId} FOR UPDATE`)[0];
    if (!po) throw new HttpError(404, `no purchase order found with id '${poId}'`);
    if (po.status === "closed") throw new HttpError(409, `purchase order ${po.po_number} is closed; goods cannot be received against it`);

    const poLines = await tx`SELECT id, line_number, qty_ordered FROM purchase_order_lines WHERE po_id = ${poId} ORDER BY line_number`;
    const n = normalizeReceipt(input, poLines.map((l) => ({ lineNumber: Number(l.line_number), quantity: Number(l.qty_ordered) })));
    const lineIdByNumber = new Map<number, string>(poLines.map((l) => [Number(l.line_number), l.id as string]));

    const same = await tx`
      SELECT gr.id, grl.po_line_id, grl.qty_received FROM goods_receipts gr
      JOIN goods_receipt_lines grl ON grl.goods_receipt_id = gr.id
      WHERE gr.po_id = ${poId} AND gr.receipt_date = ${n.receiptDate} AND gr.condition = ${n.condition}
        AND gr.receiver_name IS NOT DISTINCT FROM ${n.receiverName}`;
    const byReceipt = new Map<string, Map<string, number>>();
    for (const r of same) {
      if (!byReceipt.has(r.id)) byReceipt.set(r.id, new Map());
      byReceipt.get(r.id)!.set(r.po_line_id, Number(r.qty_received));
    }
    const wanted = new Map(n.lines.map((l) => [lineIdByNumber.get(l.lineNumber)!, l.quantity]));
    for (const existing of byReceipt.values()) {
      if (existing.size === wanted.size && [...wanted].every(([id, q]) => existing.get(id) === q)) {
        throw new HttpError(409, "this exact receipt (same date, receiver, condition and quantities) is already recorded for this purchase order");
      }
    }
    return { receiptId: await insertReceipt(tx, poId, lineIdByNumber, n), poNumber: po.po_number as string, receiptDate: n.receiptDate, condition: n.condition };
  });
}

/** The vendor a PO number belongs to, or null if no PO has that number. Used to explain why an invoice that cites a PO did not match it. */
export async function poVendorName(poNumber: string): Promise<string | null> {
  const rows = await getSql()`
    SELECT v.name FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id WHERE po.po_number = ${poNumber.trim()}`;
  return rows[0]?.name ?? null;
}

export interface PoSummary {
  id: string;
  poNumber: string;
  vendor: string;
  currency: string;
  orderDate: string;
  status: string;
  total: number;
  receivedInFull: boolean;
  invoiceCount: number;
  lines: Array<{ lineNumber: number; description: string; uom: string; ordered: number; received: number; unitPrice: number }>;
}

/** Newest first, capped. "received" counts accepted receipts only: damaged and rejected goods are not received for matching. */
export async function listPurchaseOrders(limit = 50): Promise<PoSummary[]> {
  const cap = Math.min(Math.max(1, Math.floor(limit)), 200);
  const sql = getSql();
  const pos = await sql`
    SELECT po.id, po.po_number, po.order_date, po.currency, po.status, v.name AS vendor
    FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id
    ORDER BY po.order_date DESC, po.po_number DESC LIMIT ${cap}`;
  if (pos.length === 0) return [];
  const ids = pos.map((p) => p.id as string);

  const lineRows = await sql`
    SELECT pl.po_id, pl.line_number, pl.description, pl.uom, pl.qty_ordered, pl.unit_price,
           COALESCE(SUM(grl.qty_received) FILTER (WHERE gr.condition = 'accepted'), 0) AS qty_received
    FROM purchase_order_lines pl
    LEFT JOIN goods_receipt_lines grl ON grl.po_line_id = pl.id
    LEFT JOIN goods_receipts gr ON gr.id = grl.goods_receipt_id
    WHERE pl.po_id IN ${sql(ids)}
    GROUP BY pl.id ORDER BY pl.po_id, pl.line_number`;
  const billRows = await sql`SELECT po_id, count(*)::int AS n FROM vendor_bills WHERE po_id IN ${sql(ids)} GROUP BY po_id`;
  const billCount = new Map<string, number>(billRows.map((b) => [b.po_id as string, b.n as number]));

  return pos.map((p) => {
    const lines = lineRows.filter((l) => l.po_id === p.id).map((l) => ({
      lineNumber: Number(l.line_number), description: l.description as string, uom: l.uom as string,
      ordered: Number(l.qty_ordered), received: Number(l.qty_received), unitPrice: Number(l.unit_price),
    }));
    return {
      id: p.id, poNumber: p.po_number, vendor: p.vendor, currency: p.currency, orderDate: p.order_date, status: p.status,
      total: round2(lines.reduce((s, l) => s + l.ordered * l.unitPrice, 0)),
      receivedInFull: lines.length > 0 && lines.every((l) => l.received >= l.ordered),
      invoiceCount: billCount.get(p.id) ?? 0,
      lines,
    };
  });
}
