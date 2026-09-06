import type OpenAI from "openai";
import { getSql } from "@/db/client";
import { DOLLAR_THRESHOLD_TABLE, PRECEDENCE_RANK } from "@/lib/matching/decision-matrix";
import { getEmbedding, cosineSimilarity } from "@/lib/embeddings";
import type { PurchaseOrder, PurchaseOrderLine, GoodsReceipt, Vendor, VendorCorrection } from "@/lib/types";

/**
 * Layer 2's tool contracts — ENGINE.md §3 (7 evidence-gathering tools) + ALGORITHMS.md §4
 * (3 structured-output submission tools) = 10 total. Evidence tools query the live DB
 * directly (unlike lib/matching/*, which is pure); each returns plain JSON-serializable
 * data, never a raw DB row or a thrown error for an expected "not found" case — per each
 * tool's own description, a not-found result is an actionable message, not null/undefined,
 * since a tool-calling model can't do anything useful with an opaque null.
 */

export type ToolDef = OpenAI.Responses.FunctionTool;

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef {
  return {
    type: "function",
    name,
    description,
    strict: true,
    parameters: { type: "object", properties, required, additionalProperties: false },
  };
}

// --- Evidence-gathering tool schemas (ENGINE.md §3) ---

export const GET_PO = tool(
  "get_po",
  "Look up a purchase order by its number, including all line items, quantities, unit prices, and current status. Use this to compare against what an invoice claims. Returns an actionable message (not null) if the PO doesn't exist.",
  { po_number: { type: "string" } },
  ["po_number"],
);

export const GET_RECEIPTS = tool(
  "get_receipts",
  "Return all goods-receipt records against a PO, including partial/multiple receipts, quantities accepted/rejected, and receipt dates.",
  { po_number: { type: "string" } },
  ["po_number"],
);

export const GET_VENDOR_HISTORY = tool(
  "get_vendor_history",
  "Return a vendor's trust tier, whether its bank details changed recently and when, and its recent invoice/correction history. Use this before judging whether an anomaly is suspicious or normal for this vendor.",
  { vendor_id: { type: "string" } },
  ["vendor_id"],
);

export const CHECK_DUPLICATE = tool(
  "check_duplicate",
  "Check an invoice for exact duplicates (same vendor+invoice_number) and near-duplicates (same vendor, close amount/date, similar invoice number). Returns the matched invoice id(s) and similarity score if any.",
  { invoice_id: { type: "string" } },
  ["invoice_id"],
);

export const RECALL_VENDOR_CORRECTIONS = tool(
  "recall_vendor_corrections",
  "Return previously-recorded human corrections/learned patterns for a vendor (e.g. 'this vendor's non-standard layout is normal, do not penalize confidence for it'). Always call this before finalizing a layout- or format-related exception.",
  { vendor_id: { type: "string" } },
  ["vendor_id"],
);

export const REMEMBER_CORRECTION = tool(
  "remember_correction",
  "Record a durable, vendor-scoped correction after a human overrides a decision, so future invoices from this vendor benefit from it. Call this only when explicitly instructed by a human review action, never speculatively.",
  {
    vendor_id: { type: "string" },
    pattern: { type: "string" },
    note: { type: "string" },
    source_invoice_id: { type: "string" },
  },
  ["vendor_id", "pattern", "note", "source_invoice_id"],
);

export const GET_POLICY = tool(
  "get_policy",
  "Return the current tiered policy matrix (auto-approve/escalate/block thresholds per exception type) as structured data. Call this if you need to check a threshold explicitly rather than assume one — the policy engine (a separate, deterministic stage) is the actual authority, but you may reference it for context in your rationale.",
  {},
  [],
);

export const EVIDENCE_TOOLS: ToolDef[] = [
  GET_PO,
  GET_RECEIPTS,
  GET_VENDOR_HISTORY,
  CHECK_DUPLICATE,
  RECALL_VENDOR_CORRECTIONS,
  GET_POLICY,
];

// --- Structured-output submission tools (ALGORITHMS.md §4) ---

export const SUBMIT_INVESTIGATION = tool(
  "submit_investigation",
  "Submit your final investigation conclusion. This must be your last action in this turn.",
  {
    exception_types: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
    rationale: { type: "string", description: "Must cite specific tool results, e.g. 'per check_duplicate, 0.97 similarity to INV-2288'" },
    recommended_action: { type: "string" },
  },
  ["exception_types", "confidence", "rationale", "recommended_action"],
);

export const SUBMIT_VERIFICATION = tool(
  "submit_verification",
  "Submit your independent verification verdict. This must be your last action in this turn.",
  {
    agrees: { type: "boolean", description: "Whether you agree with the Investigator's conclusion" },
    exception_types: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
    notes: { type: "string", description: "Required if agrees=false: state specifically what you assessed differently and why" },
  },
  ["agrees", "exception_types", "confidence", "notes"],
);

export const SUBMIT_EXTRACTION = tool(
  "submit_extraction",
  "Submit the extracted invoice fields. This must be your last action in this turn.",
  {
    vendor_name: { type: ["string", "null"] },
    invoice_number: { type: ["string", "null"] },
    invoice_date: { type: ["string", "null"] },
    po_reference: { type: ["string", "null"] },
    line_items: {
      type: "array",
      items: {
        type: "object",
        properties: { description: { type: "string" }, quantity: { type: "number" }, unit_price: { type: "number" } },
        required: ["description", "quantity", "unit_price"],
        additionalProperties: false,
      },
    },
    subtotal: { type: ["number", "null"] },
    tax: { type: ["number", "null"] },
    total: { type: ["number", "null"] },
    currency: { type: ["string", "null"] },
    confidence: { type: "number" },
    uncertain_fields: { type: "array", items: { type: "string" } },
  },
  [
    "vendor_name", "invoice_number", "invoice_date", "po_reference", "line_items",
    "subtotal", "tax", "total", "currency", "confidence", "uncertain_fields",
  ],
);

// --- Evidence tool handlers — the only place in lib/agent that talks to Postgres directly ---

function poFromRow(row: any): PurchaseOrder {
  return {
    id: row.id, poNumber: row.po_number, vendorId: row.vendor_id, buyerName: row.buyer_name ?? undefined,
    orderDate: row.order_date, status: row.status, poType: row.po_type,
    maxValueCeiling: row.max_value_ceiling ?? undefined, maxQtyCeiling: row.max_qty_ceiling ?? undefined,
    currency: row.currency, exchangeRate: row.exchange_rate,
  };
}

function poLineFromRow(row: any): PurchaseOrderLine {
  return {
    id: row.id, poId: row.po_id, lineNumber: row.line_number, description: row.description, uom: row.uom,
    qtyOrdered: row.qty_ordered, unitPrice: row.unit_price, glAccountId: row.gl_account_id ?? undefined,
    tolerancePct: row.tolerance_pct, finalDelivery: row.final_delivery,
  };
}

function vendorFromRow(row: any): Vendor {
  return {
    id: row.id, name: row.name, remitToAddress: row.remit_to_address ?? undefined,
    bankAccountLast4: row.bank_account_last4 ?? undefined, bankAccountChangedAt: row.bank_account_changed_at ?? undefined,
    trustTier: row.trust_tier, taxId: row.tax_id ?? undefined, w9OnFile: row.w9_on_file,
    paymentTermsCode: row.payment_terms_code ?? undefined, createdAt: row.created_at,
  };
}

function correctionFromRow(row: any): VendorCorrection {
  return { id: row.id, vendorId: row.vendor_id, pattern: row.pattern, note: row.note ?? undefined, sourceInvoiceId: row.source_invoice_id ?? undefined, createdAt: row.created_at };
}

export async function getPo(poNumber: string): Promise<{ found: boolean; message?: string; po?: PurchaseOrder; lines?: PurchaseOrderLine[] }> {
  const sql = getSql();
  const poRows = await sql`SELECT * FROM purchase_orders WHERE po_number = ${poNumber}`;
  if (poRows.length === 0) return { found: false, message: `No PO found with number '${poNumber}'` };
  const po = poFromRow(poRows[0]);
  const lineRows = await sql`SELECT * FROM purchase_order_lines WHERE po_id = ${po.id} ORDER BY line_number`;
  return { found: true, po, lines: lineRows.map(poLineFromRow) };
}

export async function getReceipts(poNumber: string): Promise<{ found: boolean; message?: string; receipts?: Array<GoodsReceipt & { lines: Array<{ poLineId: string; qtyReceived: number }> }> }> {
  const sql = getSql();
  const poRows = await sql`SELECT id FROM purchase_orders WHERE po_number = ${poNumber}`;
  if (poRows.length === 0) return { found: false, message: `No PO found with number '${poNumber}', so no receipts to return` };
  const poId = poRows[0].id;
  const receiptRows = await sql`SELECT * FROM goods_receipts WHERE po_id = ${poId} ORDER BY receipt_date`;
  const receipts = [];
  for (const r of receiptRows) {
    const lineRows = await sql`SELECT po_line_id, qty_received FROM goods_receipt_lines WHERE goods_receipt_id = ${r.id}`;
    receipts.push({
      id: r.id, poId: r.po_id, receiptDate: r.receipt_date, receiverName: r.receiver_name ?? undefined,
      condition: r.condition, finalDeliveryIndicator: r.final_delivery_indicator,
      lines: lineRows.map((l: any) => ({ poLineId: l.po_line_id, qtyReceived: l.qty_received })),
    });
  }
  return { found: true, receipts };
}

export async function getVendorHistory(vendorId: string): Promise<{ found: boolean; message?: string; vendor?: Vendor; recentInvoices?: Array<{ id: string; invoiceNumber: string; invoiceDate: string; totalAmount: number; status: string }>; corrections?: VendorCorrection[] }> {
  const sql = getSql();
  const vendorRows = await sql`SELECT * FROM vendors WHERE id = ${vendorId}`;
  if (vendorRows.length === 0) return { found: false, message: `No vendor found with id '${vendorId}'` };
  const vendor = vendorFromRow(vendorRows[0]);
  const invoiceRows = await sql`
    SELECT id, invoice_number, invoice_date, total_amount, status FROM vendor_bills
    WHERE vendor_id = ${vendorId} ORDER BY invoice_date DESC LIMIT 20`;
  const correctionRows = await sql`SELECT * FROM vendor_corrections WHERE vendor_id = ${vendorId} ORDER BY created_at DESC`;
  return {
    found: true,
    vendor,
    recentInvoices: invoiceRows.map((r: any) => ({ id: r.id, invoiceNumber: r.invoice_number, invoiceDate: r.invoice_date, totalAmount: r.total_amount, status: r.status })),
    corrections: correctionRows.map(correctionFromRow),
  };
}

/**
 * ENGINE.md §3's tool description calls for "embedding similarity on vendor+amount+date+line
 * items." The SQL query below already does the coarse narrowing on vendor/amount/date (no
 * vector index needed for that part — a handful of candidates per vendor at hackathon scale);
 * lib/embeddings.ts's real getEmbedding()/cosineSimilarity() then scores each surviving
 * candidate's invoice_number against this invoice's own, catching a resubmission with a
 * typo'd or reformatted number that a trigram heuristic could miss on genuinely different
 * phrasing. Exact duplicates (same vendor+invoice_number) are reported the same way
 * pre-match-validation.ts's own duplicate check would find them.
 */
export async function checkDuplicate(invoiceId: string): Promise<{ found: boolean; message?: string; exactDuplicateIds?: string[]; nearDuplicates?: Array<{ id: string; invoiceNumber: string; similarityScore: number }> }> {
  const sql = getSql();
  const invRows = await sql`SELECT * FROM vendor_bills WHERE id = ${invoiceId}`;
  if (invRows.length === 0) return { found: false, message: `No invoice found with id '${invoiceId}'` };
  const inv = invRows[0];

  // vendor_bills has UNIQUE(vendor_id, invoice_number) — a second row with the same pair
  // physically cannot exist once pre-match-validation.ts's duplicate check has already gated
  // the insert. This query is deliberately kept anyway (not dead code, just structurally
  // always-empty in a healthy system): it lets the Investigator's rationale explicitly cite
  // "confirmed: no exact duplicate exists" as a real, on-the-record check rather than a
  // silent assumption — consistent with the project's evidence-citation design.
  const exactRows = await sql`
    SELECT id FROM vendor_bills WHERE vendor_id = ${inv.vendor_id} AND invoice_number = ${inv.invoice_number} AND id != ${inv.id}`;

  const candidateRows = await sql`
    SELECT id, invoice_number, invoice_date, total_amount FROM vendor_bills
    WHERE vendor_id = ${inv.vendor_id} AND id != ${inv.id}
    AND ABS(total_amount - ${inv.total_amount}) <= ${inv.total_amount} * 0.02
    AND ABS(EXTRACT(EPOCH FROM (invoice_date::timestamptz - ${inv.invoice_date}::timestamptz))) <= 5 * 86400`;

  let nearDuplicates: Array<{ id: string; invoiceNumber: string; similarityScore: number }> = [];
  if (candidateRows.length > 0) {
    const thisEmbedding = await getEmbedding(inv.invoice_number);
    const scored = await Promise.all(
      candidateRows.map(async (c: any) => ({
        id: c.id,
        invoiceNumber: c.invoice_number,
        similarityScore: cosineSimilarity(thisEmbedding, await getEmbedding(c.invoice_number)),
      })),
    );
    nearDuplicates = scored.filter((c) => c.similarityScore >= 0.5).sort((a, b) => b.similarityScore - a.similarityScore);
  }

  return { found: true, exactDuplicateIds: exactRows.map((r: any) => r.id), nearDuplicates };
}

export async function recallVendorCorrections(vendorId: string): Promise<{ corrections: VendorCorrection[] }> {
  const sql = getSql();
  const rows = await sql`SELECT * FROM vendor_corrections WHERE vendor_id = ${vendorId} ORDER BY created_at DESC`;
  return { corrections: rows.map(correctionFromRow) };
}

export async function rememberCorrection(vendorId: string, pattern: string, note: string, sourceInvoiceId: string): Promise<{ id: string }> {
  const sql = getSql();
  const id = crypto.randomUUID();
  await sql`INSERT INTO vendor_corrections (id, vendor_id, pattern, note, source_invoice_id) VALUES (${id}, ${vendorId}, ${pattern}, ${note}, ${sourceInvoiceId})`;
  return { id };
}

export function getPolicy() {
  return { dollarThresholdTable: DOLLAR_THRESHOLD_TABLE, precedenceRank: PRECEDENCE_RANK };
}

/**
 * Dispatches one evidence-tool call by name. Deliberately excludes the 3 submission tools
 * (submit_investigation/submit_verification/submit_extraction) — those terminate the agent
 * loop and are handled there directly, never routed through here.
 */
export async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "get_po":
      return getPo(args.po_number as string);
    case "get_receipts":
      return getReceipts(args.po_number as string);
    case "get_vendor_history":
      return getVendorHistory(args.vendor_id as string);
    case "check_duplicate":
      return checkDuplicate(args.invoice_id as string);
    case "recall_vendor_corrections":
      return recallVendorCorrections(args.vendor_id as string);
    case "remember_correction":
      return rememberCorrection(args.vendor_id as string, args.pattern as string, args.note as string, args.source_invoice_id as string);
    case "get_policy":
      return getPolicy();
    default:
      throw new Error(`executeTool: unknown tool '${name}' — not one of the 7 evidence-gathering tools`);
  }
}
