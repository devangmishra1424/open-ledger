import { getSql } from "@/db/client";

/**
 * Translation layer between this project's real data model (lib/types.ts, db/schema.sql) and
 * the shape the real frontend (frontend/src/data/mockData.js, checked directly — not guessed)
 * actually expects. Documented as a real, found mismatch in INTEGRATION.md §5: the frontend's
 * `status: 'Clean'|'In Review'|'Blocked'|'In Progress'`, `processedByAgents: string[]`,
 * `confidenceScore`, `riskFlags`, and single `hash` per invoice don't correspond 1:1 to the
 * real `BillStatus` enum, the two real LLM roles (Investigator/Verifier), per-decision
 * confidence, `reason_code`, or the per-decision hash chain. This module is where that
 * translation happens — once, in one place — rather than duplicated across route handlers.
 */

/** Real node_id -> a label reflecting what that stage actually is, not the frontend's generic mock names. */
const NODE_LABELS: Record<string, string> = {
  extract: "Extraction Agent",
  validate: "Pre-Match Validator",
  match: "3-Way Matching Engine",
  investigate: "Investigator Agent",
  verify: "Verifier Agent",
  policy: "Policy & Compliance Engine",
  audit: "Audit & Posting Engine",
};

export function nodeLabel(nodeId: string): string {
  return NODE_LABELS[nodeId] ?? nodeId;
}

/** Real BillStatus -> the frontend's expected status string. */
export function statusToFrontend(status: string): "Clean" | "In Review" | "Blocked" | "In Progress" {
  switch (status) {
    case "approved":
    case "posted":
    case "paid":
      return "Clean";
    case "exception":
      return "In Review";
    case "void":
      return "Blocked";
    default: // 'processing', 'matched'
      return "In Progress";
  }
}

/** Deterministic 2-letter initials from a vendor name — real data, not a fabricated logo. */
export function vendorInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export interface FrontendInvoice {
  id: string;
  vendor: string;
  vendorLogo: string;
  amount: number;
  currency: string;
  terms: string;
  poNumber: string;
  status: "Clean" | "In Review" | "Blocked" | "In Progress";
  priority: "High" | "Medium" | "Low";
  receivedDate: string;
  dueDate: string;
  progress: number;
  taxId: string;
  confidenceScore: number;
  processedByAgents: string[];
  riskFlags: string[];
  hash: string;
  items: Array<{ description: string; qty: number; rate: number; amount: number }>;
  /** Real per-stage decision trail — what the swimlane/"Ask Why" UI renders instead of a fixed fictional 5-agent roster. */
  decisions: Array<{ id: string; nodeId: string; label: string; actionTaken: string | null; reasonCode: string | null; confidence: number | null; hash: string }>;
}

const PIPELINE_STAGE_COUNT = 7; // extract/validate/match/investigate/verify/policy/audit

/**
 * Builds the frontend-shaped invoice object from real rows. `decisions` must be this
 * invoice's own decisions in seq order (not superseded ones filtered out — callers that only
 * want the current chain should filter before calling, callers that want full history pass
 * everything).
 */
export function toFrontendInvoice(params: {
  bill: any; // raw vendor_bills row
  vendorName: string;
  taxId: string | null;
  paymentTermsCode: string | null;
  poNumber: string | null;
  decisions: Array<{ id: string; nodeId: string; actionTaken?: string; reasonCode?: string; confidence?: number; hash: string }>;
  lines: Array<{ description: string; qtyInvoiced: number; unitPrice: number }>;
}): FrontendInvoice {
  const { bill, vendorName, taxId, paymentTermsCode, poNumber, decisions, lines } = params;

  const stagesRun = new Set(decisions.map((d) => d.nodeId));
  const progress = Math.round((stagesRun.size / PIPELINE_STAGE_COUNT) * 100);

  const processedByAgents = decisions.map((d) => nodeLabel(d.nodeId));

  const riskFlags = decisions
    .filter((d) => d.reasonCode && d.reasonCode !== "CLEAN_MATCH")
    .map((d) => d.reasonCode!)
    .filter((v, i, arr) => arr.indexOf(v) === i); // de-dup

  const confidences = decisions.map((d) => d.confidence).filter((c): c is number => c != null);
  const confidenceScore = confidences.length > 0
    ? Math.round((confidences.reduce((s, c) => s + c, 0) / confidences.length) * 1000) / 10 // 0-1 -> 0-100, 1dp
    : 100;

  const latestHash = decisions.length > 0 ? decisions[decisions.length - 1].hash : "";

  const status = statusToFrontend(bill.status);
  const priority: FrontendInvoice["priority"] = status === "In Review" || status === "Blocked" ? "High" : status === "In Progress" ? "Medium" : "Low";

  return {
    id: bill.id,
    vendor: vendorName,
    vendorLogo: vendorInitials(vendorName),
    amount: bill.total_amount,
    currency: bill.currency,
    terms: paymentTermsCode ?? "—",
    poNumber: poNumber ?? "Non-PO",
    status,
    priority,
    receivedDate: bill.received_at,
    dueDate: bill.due_date ?? bill.invoice_date,
    progress,
    taxId: taxId ?? "—",
    confidenceScore,
    processedByAgents,
    riskFlags,
    hash: latestHash,
    items: lines.map((l) => ({ description: l.description, qty: l.qtyInvoiced, rate: l.unitPrice, amount: l.qtyInvoiced * l.unitPrice })),
    decisions: decisions.map((d) => ({
      id: d.id, nodeId: d.nodeId, label: nodeLabel(d.nodeId),
      actionTaken: d.actionTaken ?? null, reasonCode: d.reasonCode ?? null,
      confidence: d.confidence != null ? Math.round(d.confidence * 1000) / 10 : null,
      hash: d.hash,
    })),
  };
}

/** Fetches and assembles a FrontendInvoice for one vendor_bills id. Returns undefined if not found (including a missing/undefined id itself — the postgres driver throws a hard, unhandled error on an undefined query parameter rather than a normal empty result, so this is checked before the query, not left to surface as a 500). */
export async function getFrontendInvoice(billId: string | undefined | null): Promise<FrontendInvoice | undefined> {
  if (!billId) return undefined;
  const sql = getSql();
  const billRows = await sql`SELECT * FROM vendor_bills WHERE id = ${billId}`;
  if (billRows.length === 0) return undefined;
  const bill = billRows[0];

  const [vendorRows, poRows, lineRows, decisionRows] = await Promise.all([
    sql`SELECT name, tax_id, payment_terms_code FROM vendors WHERE id = ${bill.vendor_id}`,
    bill.po_id ? sql`SELECT po_number FROM purchase_orders WHERE id = ${bill.po_id}` : Promise.resolve([]),
    sql`SELECT description, qty_invoiced, unit_price FROM vendor_bill_lines WHERE vendor_bill_id = ${bill.id}`,
    sql`SELECT id, node_id, action_taken, reason_code, confidence, hash FROM decisions WHERE invoice_id = ${bill.id} AND superseded_by_id IS NULL ORDER BY seq ASC`,
  ]);
  const vendor = vendorRows[0];

  return toFrontendInvoice({
    bill,
    vendorName: vendor?.name ?? "Unknown Vendor",
    taxId: vendor?.tax_id ?? null,
    paymentTermsCode: vendor?.payment_terms_code ?? null,
    poNumber: poRows[0]?.po_number ?? null,
    decisions: decisionRows.map((d: any) => ({ id: d.id, nodeId: d.node_id, actionTaken: d.action_taken, reasonCode: d.reason_code, confidence: d.confidence, hash: d.hash })),
    lines: lineRows.map((l: any) => ({ description: l.description, qtyInvoiced: l.qty_invoiced, unitPrice: l.unit_price })),
  });
}

/** List version — one query per invoice's decisions/lines would be N+1 at scale, fine at hackathon-demo scale (a few dozen invoices). */
export async function listFrontendInvoices(statusFilter?: string): Promise<FrontendInvoice[]> {
  const sql = getSql();
  const billRows = statusFilter
    ? await sql`SELECT * FROM vendor_bills WHERE status = ${statusFilter} ORDER BY received_at DESC`
    : await sql`SELECT * FROM vendor_bills ORDER BY received_at DESC`;

  const results: FrontendInvoice[] = [];
  for (const bill of billRows) {
    const inv = await getFrontendInvoice(bill.id);
    if (inv) results.push(inv);
  }
  return results;
}
