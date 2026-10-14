import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { getSql } from "@/db/client";
import { HttpError } from "@/lib/http";

/**
 * Creating an invoice (vendor_bills + lines, and the vendor if it is new) from validated input.
 * Shared by POST /api/invoices (structured) and POST /api/invoices/ingest (read off a document),
 * so both enforce the same rules and write in ONE transaction: no half-created invoices.
 *
 * Numbers: lines are the source of truth for `subtotal`; `tax_total` is the tax the invoice states
 * (0 if none); `total_amount` is what the vendor is owed. Before this, ingest stored the sum of the
 * lines as the total and dropped the invoice's own tax, so an invoice for $810.00 (incl. $60 tax)
 * was recorded as a $750.00 liability.
 */

export interface NewBillLine { description: string; quantity: number; unitPrice: number }

export interface NewBillInput {
  vendorId?: string;
  vendorName?: string;
  poId?: string | null;
  poNumber?: string | null;
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
  dueDate?: string | null;
  currency?: string | null;
  lines: NewBillLine[];
  /** Tax stated on the invoice. */
  tax?: number | null;
  /** Total stated on the invoice. */
  total?: number | null;
  /** Round off minus any invoice-level discount, signed (e.g. +0.34, -0.35, -500). total = lines + tax + adjustment. */
  adjustment?: number | null;
  rawSource?: string | null;
  /** The uploaded file this invoice was read from (source_documents.id). */
  sourceDocumentId?: string | null;
  /**
   * true (API callers): a stated total that disagrees with lines + tax is rejected (422).
   * false (read off a document): kept as stated — the extractor already lowered its confidence
   * for the mismatch, which routes the invoice to a person.
   */
  strictTotals: boolean;
}

export interface CreatedBill { billId: string; vendorId: string; invoiceNumber: string; vendorCreated: boolean }

const CENT = 0.02;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
const MAX_LINES = 500;

const round2 = (n: number) => Math.round(n * 100) / 100;

function finiteNumber(v: unknown, label: string, opts: { min?: number } = {}): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new HttpError(400, `${label} must be a number`);
  if (opts.min !== undefined && v < opts.min) throw new HttpError(400, `${label} must be at least ${opts.min}`);
  return v;
}

/** Validates the input and returns the normalized numbers; throws HttpError 400/422. Pure — exported for tests. */
export function normalizeBillInput(input: NewBillInput, today = new Date().toISOString().slice(0, 10)) {
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new HttpError(400, "an invoice needs at least one line item");
  if (input.lines.length > MAX_LINES) throw new HttpError(400, `too many line items (max ${MAX_LINES})`);
  const lines = input.lines.map((l, i) => {
    const description = typeof l.description === "string" ? l.description.trim() : "";
    if (!description) throw new HttpError(400, `line ${i + 1}: description is required`);
    return {
      description: description.slice(0, 500),
      quantity: finiteNumber(l.quantity, `line ${i + 1}: quantity`, { min: 0.0001 }),
      unitPrice: finiteNumber(l.unitPrice, `line ${i + 1}: unit price`, { min: 0 }),
    };
  });

  const subtotal = round2(lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0));
  const tax = input.tax == null ? 0 : finiteNumber(input.tax, "tax", { min: 0 });
  const adjustment = input.adjustment == null ? 0 : finiteNumber(input.adjustment, "adjustment");
  const expectedTotal = round2(subtotal + tax + adjustment);
  let total = expectedTotal;
  if (input.total != null) {
    const stated = finiteNumber(input.total, "total", { min: 0 });
    if (input.strictTotals && Math.abs(stated - expectedTotal) > CENT) {
      const adj = adjustment !== 0 ? ` plus round off / discount (${adjustment.toFixed(2)})` : "";
      throw new HttpError(422, `the stated total ${stated.toFixed(2)} does not equal the line items (${subtotal.toFixed(2)}) plus tax (${tax.toFixed(2)})${adj} = ${expectedTotal.toFixed(2)}`);
    }
    total = stated;
  }
  if (!(total > 0)) throw new HttpError(422, "the invoice total must be greater than zero");

  const invoiceDate = input.invoiceDate ?? today;
  if (!ISO_DATE.test(invoiceDate)) throw new HttpError(400, "invoiceDate must be YYYY-MM-DD");
  if (input.dueDate != null && !ISO_DATE.test(input.dueDate)) throw new HttpError(400, "dueDate must be YYYY-MM-DD");
  const currency = (input.currency ?? "USD").toUpperCase();
  if (!CURRENCY.test(currency)) throw new HttpError(400, "currency must be a 3-letter code such as USD");

  return { lines, subtotal, tax: round2(tax), adjustment: round2(adjustment), total: round2(total), invoiceDate, dueDate: input.dueDate ?? null, currency };
}

/** One payee however it is typed: case and runs of spaces do not matter. Legal suffixes and punctuation are NOT folded: "Acme Ltd" and "Acme Inc" can be different legal entities, and merging payees is a fraud risk. */
export function vendorKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

type Tx = TransactionSql;

/** The vendor by id (404 if unknown) or by name (matched by vendorKey, created with trust tier 'new' when there is none). Must run inside the caller's transaction. */
export async function findOrCreateVendor(tx: Tx, input: { vendorId?: string; vendorName?: string }): Promise<{ vendorId: string; vendorCreated: boolean }> {
  if (input.vendorId) {
    const rows = await tx`SELECT id FROM vendors WHERE id = ${input.vendorId}`;
    if (rows.length === 0) throw new HttpError(404, `no vendor found with id '${input.vendorId}'`);
    return { vendorId: input.vendorId, vendorCreated: false };
  }
  const name = input.vendorName?.trim();
  if (!name) throw new HttpError(400, "vendor name is required");
  // [[:space:]] rather than \s: a backslash inside a tagged template is dropped before it reaches the database.
  const existing = await tx`
    SELECT id FROM vendors
    WHERE lower(btrim(regexp_replace(name, '[[:space:]]+', ' ', 'g'))) = ${vendorKey(name)}
    ORDER BY created_at, id LIMIT 1`;
  if (existing.length > 0) return { vendorId: existing[0].id, vendorCreated: false };
  const vendorId = randomUUID();
  await tx`INSERT INTO vendors (id, name, trust_tier) VALUES (${vendorId}, ${name.slice(0, 200)}, 'new')`;
  return { vendorId, vendorCreated: true };
}

export async function createBill(input: NewBillInput): Promise<CreatedBill> {
  const n = normalizeBillInput(input);
  const sql = getSql();

  return sql.begin(async (tx) => {
    const { vendorId, vendorCreated } = await findOrCreateVendor(tx, input);

    let poId: string | null = input.poId ?? null;
    // The PO number the invoice cites. Kept even when no such PO is on file yet (po_id stays NULL, a non-PO invoice
    // for now), so the invoice can be linked when the PO is added (lib/pipeline/recheck.ts).
    let poReference: string | null = input.poNumber?.trim() || null;
    if (!poId && poReference) {
      const poRows = await tx`SELECT id FROM purchase_orders WHERE po_number = ${poReference} AND vendor_id = ${vendorId}`;
      poId = poRows[0]?.id ?? null;
    } else if (poId && !poReference) {
      poReference = (await tx`SELECT po_number FROM purchase_orders WHERE id = ${poId}`)[0]?.po_number ?? null;
    }

    const billId = randomUUID();
    const invoiceNumber = (input.invoiceNumber ?? "").trim() || `INV-${billId.slice(0, 8)}`;

    const dup = await tx`SELECT id FROM vendor_bills WHERE vendor_id = ${vendorId} AND invoice_number = ${invoiceNumber}`;
    if (dup.length > 0) {
      throw new HttpError(409, `invoice ${invoiceNumber} from this vendor was already received (id ${dup[0].id})`);
    }

    // Default expense account so an approval can post even when no line ever matches a PO line
    // (postBillApproval's only other source for one).
    const glRows = await tx`SELECT id FROM chart_of_accounts WHERE account_number = '6000'`;
    const defaultGl: string | null = glRows[0]?.id ?? null;

    await tx`
      INSERT INTO vendor_bills (id, vendor_id, po_id, po_reference, invoice_number, invoice_date, due_date, currency, subtotal, tax_total, adjustment_total, total_amount, raw_source, source_document_id)
      VALUES (${billId}, ${vendorId}, ${poId}, ${poReference}, ${invoiceNumber}, ${n.invoiceDate}, ${n.dueDate}, ${n.currency}, ${n.subtotal}, ${n.tax}, ${n.adjustment}, ${n.total}, ${input.rawSource ?? null}, ${input.sourceDocumentId ?? null})`;
    for (const l of n.lines) {
      await tx`
        INSERT INTO vendor_bill_lines (id, vendor_bill_id, description, qty_invoiced, unit_price, gl_account_id)
        VALUES (${randomUUID()}, ${billId}, ${l.description}, ${l.quantity}, ${l.unitPrice}, ${defaultGl})`;
    }
    return { billId, vendorId, invoiceNumber, vendorCreated };
  });
}
