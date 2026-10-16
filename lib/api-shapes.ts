import { getSql } from "@/db/client";
import { checkHumanAction } from "@/lib/bill-workflow";
import { detectBankChangeGates, type BankChangeGateCheck } from "@/lib/ledger/bank-change-review";
import { buildThreeWay, type ThreeWay } from "@/lib/three-way";
import type { BillStatus } from "@/lib/types";
import { readableAgentFailure } from "@/lib/agent/llm";

/**
 * The read model: turns the real tables (vendor_bills, decisions, ...) into the one shape every
 * screen renders. Everything a screen shows about an invoice's state — what it is, why, what the
 * person can do next — is computed HERE, once, from the same rules the write side enforces
 * (lib/bill-workflow.ts), so a button is never offered that the server will then refuse.
 *
 * Two layers of status are exposed on purpose:
 *   - `status` / the legacy fields: the four-value vocabulary the existing screens were built on
 *     (Clean | In Review | Blocked | In Progress), kept so nothing breaks.
 *   - `state` + `summary` + `actions`: the product-level truth (processing / needs_attention /
 *     approved / paid / rejected, with a one-line "what happened and why").
 */

/** Real node_id -> a label reflecting what that stage actually is. */
const NODE_LABELS: Record<string, string> = {
  extract: "Extraction",
  validate: "Pre-Match Validator",
  match: "3-Way Matching Engine",
  investigate: "Investigator Agent",
  verify: "Verifier Agent",
  policy: "Policy Engine",
  audit: "Posting & Payment",
  human_review: "Human Review",
  audit_assemble: "Evidence for an auditor",
};

export function nodeLabel(nodeId: string): string {
  return NODE_LABELS[nodeId] ?? nodeId;
}

/** Real BillStatus -> the legacy four-value status the older screens use. */
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

export type CaseState = "processing" | "needs_attention" | "approved" | "paid" | "rejected";
export type HumanChoiceName = "approve" | "reject" | "contest";

export interface DecisionView {
  id: string;
  nodeId: string;
  label: string;
  /** Who produced it: a model id, an engine name, or "human:<name>". */
  actor: string;
  /** Set only when an LLM produced it. */
  model: string | null;
  actionTaken: string | null;
  reasonCode: string | null;
  /** 0-100, one decimal. */
  confidence: number | null;
  hash: string;
  at: string;
  claims: string[];
}

export interface HumanActionView {
  decisionId: string;
  action: HumanChoiceName;
  reviewer: string;
  note: string | null;
  at: string;
}

export interface ActionAvailability {
  allowed: boolean;
  /** Why not — written for the person looking at a disabled button. */
  reason?: string;
}

export interface FrontendInvoice {
  id: string;
  /** The number printed on the invoice (what a person calls it), as opposed to the internal id. */
  invoiceNumber: string;
  vendor: string;
  vendorLogo: string;
  amount: number;
  currency: string;
  terms: string;
  poNumber: string;
  /** Legacy four-value status; see the module note. */
  status: "Clean" | "In Review" | "Blocked" | "In Progress";
  priority: "High" | "Medium" | "Low";
  receivedDate: string;
  invoiceDate: string;
  dueDate: string;
  /** 100 once the invoice is no longer processing; otherwise stages run so far / 7. */
  progress: number;
  taxId: string;
  /** Mean of the stages that reported a confidence, 0-100; null when none did. */
  confidenceScore: number | null;
  processedByAgents: string[];
  riskFlags: string[];
  /** Hash of this invoice's latest decision — the tip of its trail. */
  hash: string;
  items: Array<{ description: string; qty: number; rate: number; amount: number }>;
  decisions: DecisionView[];
  /** The uploaded file this invoice was entered from (GET /api/documents/:id), when it came from a document. */
  sourceDocumentId: string | null;
  /** The PO number the invoice cites, linked or not (a non-PO invoice keeps it so it can be linked later). */
  poReference: string | null;
  taxTotal: number;
  /** Round off minus invoice-level discount: total = items + tax + adjustment. */
  adjustmentTotal: number;
  /** A credit memo is money the vendor owes back: approving it lowers what is owed to them and pays nothing. */
  invoiceType: "standard" | "credit_memo";

  rawStatus: BillStatus;
  state: CaseState;
  summary: {
    headline: string;
    detail: string | null;
    /** "system", or the person's name when a human made the call. */
    decidedBy: string | null;
  };
  reason: { code: string; name: string; description: string } | null;
  actions: Record<HumanChoiceName, ActionAvailability>;
  /** Present while a vendor bank-detail change on this invoice's vendor still holds payment. */
  bankChange: {
    reviewId: string | null;
    status: string;
    step: "start_callback" | "record_outcome" | "second_signoff" | "blocked";
    /** Who phoned the vendor, and which number — recorded so a DIFFERENT person can be required to sign off. */
    callbackBy: string | null;
    callbackPhone: string | null;
    oldBankLast4: string | null;
    newBankLast4: string | null;
  } | null;
  humanActions: HumanActionView[];
  payment: { reference: string; simulated: boolean } | null;
}

/** One readable sentence-ish for a headline box; the full text stays in the decision trail. */
export function clip(text: string | null | undefined, max = 200): string | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max).replace(/[,;:\-–—(]+$/, "")}…`;
}

const PIPELINE_STAGE_COUNT = 7; // extract/validate/match/investigate/verify/policy/audit

export interface DecisionInput {
  id: string;
  nodeId: string;
  agentId: string;
  model?: string | null;
  actionTaken?: string | null;
  reasonCode?: string | null;
  confidence?: number | null;
  hash: string;
  createdAt: string;
  claims?: string[];
  triggeredByActor?: string | null;
}

const HUMAN_ACTION_BY_TAKEN: Record<string, HumanChoiceName> = {
  human_approved: "approve",
  human_rejected: "reject",
  human_contested: "contest",
};

function lastOf<T>(items: T[], pred: (t: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (pred(items[i])) return items[i];
  return undefined;
}

const FINDING_LINE = /^(EXC-[A-Z_]+|R99_AGENT_ERROR|CLEAN_MATCH|POLICY_LIMIT|INVESTIGATOR_HOLD):\s*[a-z_0-9]+$/;

/**
 * The specific facts the match step recorded for one finding (the claim right after "CODE: action"),
 * e.g. which line was over its PO price and by how much. Null for records written before facts were
 * recorded, which then fall back to the reason's general description.
 */
export function findingFact(match: DecisionInput | undefined, code: string): string | null {
  const claims = match?.claims ?? [];
  const i = claims.findIndex((c) => c.startsWith(`${code}:`) && FINDING_LINE.test(c));
  const next = i >= 0 ? claims[i + 1] : undefined;
  return next && !FINDING_LINE.test(next) ? next : null;
}

/** Pure: which product-level state an invoice is in. `paymentFailed` = it posted but the payment did not go out. */
export function deriveState(status: BillStatus, paymentFailed: boolean): CaseState {
  switch (status) {
    case "exception": return "needs_attention";
    case "void": return "rejected";
    case "paid": return "paid";
    case "approved":
    case "posted": return paymentFailed ? "needs_attention" : "approved";
    default: return "processing"; // 'processing', 'matched'
  }
}

function bankChangeStep(gate: BankChangeGateCheck): NonNullable<FrontendInvoice["bankChange"]>["step"] {
  switch (gate.status) {
    case "callback_confirmed": return "second_signoff";
    case "callback_failed": return "blocked";
    case "callback_pending": return gate.review?.callbackAt ? "record_outcome" : "start_callback";
    default: return "start_callback"; // "flagged": no review row yet
  }
}

/** Pure builder: everything fetched in, the finished view out — so it can be unit-tested without a database. */
export function toFrontendInvoice(params: {
  bill: any; // raw vendor_bills row
  vendorName: string;
  taxId: string | null;
  paymentTermsCode: string | null;
  poNumber: string | null;
  /** This invoice's live (non-superseded) decisions in chain order. */
  decisions: DecisionInput[];
  lines: Array<{ description: string; qtyInvoiced: number; unitPrice: number }>;
  reasons: Map<string, { name: string; description: string }>;
  gate?: BankChangeGateCheck;
  payment?: { reference: string } | null;
}): FrontendInvoice {
  const { bill, vendorName, taxId, paymentTermsCode, poNumber, decisions, lines, reasons, gate, payment } = params;
  const status = bill.status as BillStatus;

  // The pipeline's own steps. A person's review and handing evidence to an auditor are on the trail too, but are not stages.
  const machine = decisions.filter((d) => d.nodeId !== "human_review" && d.nodeId !== "audit_assemble");
  const policy = lastOf(machine, (d) => d.nodeId === "policy");
  const audit = lastOf(machine, (d) => d.nodeId === "audit");
  const hasReconsiderable = machine.some((d) => d.nodeId === "investigate" || d.nodeId === "verify");

  const humanActions: HumanActionView[] = decisions
    .filter((d) => d.nodeId === "human_review" && HUMAN_ACTION_BY_TAKEN[d.actionTaken ?? ""])
    .map((d) => ({
      decisionId: d.id,
      action: HUMAN_ACTION_BY_TAKEN[d.actionTaken!],
      reviewer: d.triggeredByActor ?? d.agentId.replace(/^human:/, ""),
      note: d.claims?.[0] ?? null,
      at: d.createdAt,
    }));

  const paymentFailed = audit?.actionTaken === "payment_failed";
  const state = deriveState(status, paymentFailed);
  const holdActive = Boolean(gate?.gating) && state === "needs_attention" && !paymentFailed;

  // A step that failed and left the policy decision with no real reason (older records were written
  // with CLEAN_MATCH on a block caused by a failed AI step) is still a system failure, and is shown as one.
  const failedStep = lastOf(machine, (d) => d.actionTaken === "error");
  const policyReason = (policy?.reasonCode && policy.reasonCode !== "CLEAN_MATCH") ? policy.reasonCode : null;
  const reasonCode = policyReason ?? (state === "needs_attention" && failedStep && !paymentFailed ? "R99_AGENT_ERROR" : null);
  const reasonInfo = reasonCode ? reasons.get(reasonCode) : undefined;
  const reason = reasonCode && reasonInfo ? { code: reasonCode, name: reasonInfo.name, description: reasonInfo.description } : null;

  // --- what happened, in one line ---
  const lastHumanApprove = lastOf(humanActions, (h) => h.action === "approve");
  const creditMemo = bill.invoice_type === "credit_memo";
  const lastHumanReject = lastOf(humanActions, (h) => h.action === "reject");
  let headline: string;
  let detail: string | null = null;
  let decidedBy: string | null = null;
  switch (state) {
    case "processing":
      headline = "Being processed";
      detail = `${new Set(machine.map((d) => d.nodeId)).size} of ${PIPELINE_STAGE_COUNT} stages done`;
      break;
    case "needs_attention":
      if (paymentFailed) {
        headline = "Approved, but the payment did not go out";
        detail = audit?.claims?.[0] ?? null;
      } else if (holdActive) {
        headline = "On hold: the vendor's bank details changed";
        detail = "Money cannot move until the change is verified by a callback and signed off by a second reviewer.";
      } else if (reason?.code === "R99_AGENT_ERROR") {
        // The invoice may be perfectly fine; the automated review did not finish. Say that, with the real cause.
        headline = "The automated review did not finish";
        const failure = lastOf(machine, (d) => d.actionTaken === "error");
        const failureText = failure?.claims?.[0]?.replace(/^(Investigator|Verifier) failed: /, "");
        detail = (clip(failureText ? readableAgentFailure(failureText, failure?.model) : undefined, 260) ?? "A step failed.") + " A person has to decide, or you can retry the AI review.";
      } else {
        headline = reason ? reason.name : "Needs a decision";
        // The most specific line first: the limit that was hit, or what the engine found on this invoice
        // (which line, by how much); the reason's description is only the general rule.
        const policyClaims = policy?.claims ?? [];
        const verifierDisagreed = policyClaims.some((c) => c.startsWith("Verifier disagreed"));
        if (reason?.code === "POLICY_LIMIT") detail = clip(policyClaims[policyClaims.length - 1], 260);
        else if (reason?.code === "INVESTIGATOR_HOLD") detail = clip(policyClaims[0], 260);
        else {
          const fact = reason ? findingFact(lastOf(machine, (d) => d.nodeId === "match"), reason.code) : null;
          detail = clip(fact, 260)
            ?? (verifierDisagreed && reason ? `${reason.description} A second AI check also disagreed with the first, so the stricter outcome stands.` : null)
            ?? clip(policyClaims[0]) ?? reason?.description ?? clip(audit?.claims?.[0]);
        }
      }
      break;
    case "approved":
    case "paid": {
      decidedBy = lastHumanApprove ? lastHumanApprove.reviewer : "system";
      if (creditMemo) {
        // Never 'paid': a credit is not paid out, it lowers what is owed to the vendor.
        headline = `${lastHumanApprove ? `Approved by ${lastHumanApprove.reviewer}` : "Auto-approved: the credit fits inside what is open on its invoice"}, credit posted to the ledger`;
        detail = `It lowers what you owe ${vendorName}. Nothing is paid.`;
        break;
      }
      const how = lastHumanApprove ? `Approved by ${lastHumanApprove.reviewer}` : "Auto-approved: clean three-way match";
      headline = state === "paid" ? `${how}, paid` : `${how}, posted to the ledger`;
      detail = state === "paid" && payment ? `Payment ${payment.reference}${payment.reference.startsWith("SIMULATED-") ? " (simulated: no money moved)" : ""}` : null;
      break;
    }
    case "rejected":
      decidedBy = lastHumanReject ? lastHumanReject.reviewer : "system";
      headline = lastHumanReject ? `Rejected by ${lastHumanReject.reviewer}` : (reason ? `Rejected automatically: ${reason.name}` : "Rejected automatically");
      detail = lastHumanReject?.note
        ?? clip(reason ? findingFact(lastOf(machine, (d) => d.nodeId === "match"), reason.code) : null, 260)
        ?? reason?.description ?? null;
      break;
  }

  // --- what the person can do right now: the same rules the write side enforces ---
  const availability = (action: HumanChoiceName): ActionAvailability => {
    const check = checkHumanAction(status, action, { bankChangeHold: holdActive });
    if (!check.allowed) return { allowed: false, reason: check.reason };
    if (check.alreadyDone) return { allowed: false, reason: action === "approve" ? "already approved" : "already rejected" };
    if (paymentFailed && action !== "contest") return { allowed: false, reason: "already posted to the ledger — retry the payment instead" };
    if (action === "contest" && !hasReconsiderable) {
      return { allowed: false, reason: "stopped by a deterministic rule before any AI review ran, so there is no AI judgment to reconsider" };
    }
    return { allowed: true };
  };

  const stagesRun = new Set(machine.map((d) => d.nodeId));
  const progress = state === "processing" ? Math.round((stagesRun.size / PIPELINE_STAGE_COUNT) * 100) : 100;

  const riskFlags = [...new Set(machine.filter((d) => d.reasonCode && d.reasonCode !== "CLEAN_MATCH").map((d) => d.reasonCode!))];
  const confidences = machine.map((d) => d.confidence).filter((c): c is number => c != null);
  const confidenceScore = confidences.length > 0
    ? Math.round((confidences.reduce((s, c) => s + c, 0) / confidences.length) * 1000) / 10 // 0-1 -> 0-100, 1dp
    : null;

  const priority: FrontendInvoice["priority"] = state === "needs_attention" ? "High" : state === "processing" ? "Medium" : "Low";
  const latest = decisions[decisions.length - 1];

  return {
    id: bill.id,
    invoiceNumber: bill.invoice_number,
    vendor: vendorName,
    vendorLogo: vendorInitials(vendorName),
    amount: Number(bill.total_amount),
    currency: bill.currency,
    terms: paymentTermsCode ?? "—",
    poNumber: poNumber ?? "Non-PO",
    status: statusToFrontend(status),
    priority,
    receivedDate: bill.received_at,
    invoiceDate: bill.invoice_date,
    dueDate: bill.due_date ?? bill.invoice_date,
    progress,
    taxId: taxId ?? "—",
    confidenceScore,
    processedByAgents: machine.map((d) => nodeLabel(d.nodeId)),
    riskFlags,
    hash: latest?.hash ?? "",
    items: lines.map((l) => ({ description: l.description, qty: l.qtyInvoiced, rate: l.unitPrice, amount: Math.round(l.qtyInvoiced * l.unitPrice * 100) / 100 })),
    sourceDocumentId: bill.source_document_id ?? null,
    poReference: bill.po_reference ?? null,
    taxTotal: Number(bill.tax_total ?? 0),
    adjustmentTotal: Number(bill.adjustment_total ?? 0),
    invoiceType: creditMemo ? "credit_memo" : "standard",
    decisions: decisions.map((d) => ({
      id: d.id, nodeId: d.nodeId, label: nodeLabel(d.nodeId),
      actor: d.agentId, model: d.model ?? null,
      actionTaken: d.actionTaken ?? null, reasonCode: d.reasonCode ?? null,
      confidence: d.confidence != null ? Math.round(d.confidence * 1000) / 10 : null,
      hash: d.hash, at: d.createdAt,
      // A failed step's claim may be a provider's raw error text: worded for the screen, the record itself unchanged.
      claims: d.actionTaken === "error" ? (d.claims ?? []).map((c) => readableAgentFailure(c, d.model)) : (d.claims ?? []),
    })),
    rawStatus: status,
    state,
    summary: { headline, detail, decidedBy },
    reason,
    actions: { approve: availability("approve"), reject: availability("reject"), contest: availability("contest") },
    bankChange: gate?.gating
      ? {
          reviewId: gate.review?.id ?? null, status: gate.status, step: bankChangeStep(gate),
          callbackBy: gate.review?.callbackConfirmedBy ?? null, callbackPhone: gate.review?.callbackPhoneUsed ?? null,
          oldBankLast4: gate.review?.oldBankLast4 ?? null, newBankLast4: gate.review?.newBankLast4 ?? null,
        }
      : null,
    humanActions,
    payment: payment ? { reference: payment.reference, simulated: payment.reference.startsWith("SIMULATED-") } : null,
  };
}

function parseClaims(raw: unknown): string[] {
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((c: any) => String(c?.text ?? "")).filter(Boolean) : [];
  } catch {
    // A claims column that is not valid JSON is a data fault, not something to hide: show it as one claim.
    return [`(unreadable claims: ${raw.slice(0, 80)})`];
  }
}

/** Loads and assembles the views for a set of vendor_bills rows in a fixed number of queries (not per invoice). */
async function assemble(bills: any[]): Promise<FrontendInvoice[]> {
  if (bills.length === 0) return [];
  const sql = getSql();
  const ids = bills.map((b) => b.id);
  const vendorIds = [...new Set(bills.map((b) => b.vendor_id))];
  const poIds = [...new Set(bills.map((b) => b.po_id).filter(Boolean))];

  const [vendors, pos, lines, decisions, reasons, gates, payments] = await Promise.all([
    sql`SELECT id, name, tax_id, payment_terms_code FROM vendors WHERE id IN ${sql(vendorIds)}`,
    poIds.length > 0 ? sql`SELECT id, po_number FROM purchase_orders WHERE id IN ${sql(poIds)}` : Promise.resolve([] as any[]),
    sql`SELECT vendor_bill_id, description, qty_invoiced, unit_price FROM vendor_bill_lines WHERE vendor_bill_id IN ${sql(ids)}`,
    sql`SELECT id, invoice_id, node_id, agent_id, model, action_taken, reason_code, confidence, hash, created_at, claims, triggered_by_actor
        FROM decisions WHERE invoice_id IN ${sql(ids)} AND superseded_by_id IS NULL ORDER BY seq ASC`,
    sql`SELECT code, name, description FROM reason_codes`,
    detectBankChangeGates(vendorIds),
    sql`SELECT pa.vendor_bill_id, p.positive_pay_reference FROM payment_applications pa JOIN payments p ON p.id = pa.payment_id WHERE pa.vendor_bill_id IN ${sql(ids)}`,
  ]);

  const vendorById = new Map(vendors.map((v: any) => [v.id, v]));
  const poById = new Map(pos.map((p: any) => [p.id, p]));
  const reasonByCode = new Map<string, { name: string; description: string }>(reasons.map((r: any) => [r.code as string, { name: r.name as string, description: r.description as string }]));
  const paymentByBill = new Map<string, { reference: string }>(payments.map((p: any) => [p.vendor_bill_id as string, { reference: (p.positive_pay_reference ?? "") as string }]));
  const linesByBill = new Map<string, any[]>();
  for (const l of lines) (linesByBill.get(l.vendor_bill_id) ?? linesByBill.set(l.vendor_bill_id, []).get(l.vendor_bill_id)!).push(l);
  const decisionsByBill = new Map<string, DecisionInput[]>();
  for (const d of decisions) {
    const input: DecisionInput = {
      id: d.id, nodeId: d.node_id, agentId: d.agent_id, model: d.model, actionTaken: d.action_taken, reasonCode: d.reason_code,
      confidence: d.confidence, hash: d.hash, createdAt: d.created_at, claims: parseClaims(d.claims), triggeredByActor: d.triggered_by_actor,
    };
    (decisionsByBill.get(d.invoice_id) ?? decisionsByBill.set(d.invoice_id, []).get(d.invoice_id)!).push(input);
  }

  return bills.map((bill) => {
    const vendor: any = vendorById.get(bill.vendor_id);
    return toFrontendInvoice({
      bill,
      vendorName: vendor?.name ?? "Unknown Vendor",
      taxId: vendor?.tax_id ?? null,
      paymentTermsCode: vendor?.payment_terms_code ?? null,
      poNumber: bill.po_id ? ((poById.get(bill.po_id) as any)?.po_number ?? null) : null,
      decisions: decisionsByBill.get(bill.id) ?? [],
      lines: (linesByBill.get(bill.id) ?? []).map((l) => ({ description: l.description, qtyInvoiced: Number(l.qty_invoiced), unitPrice: Number(l.unit_price) })),
      reasons: reasonByCode,
      gate: gates.get(bill.vendor_id),
      payment: paymentByBill.get(bill.id) ?? null,
    });
  });
}

/** Fetches and assembles a FrontendInvoice for one vendor_bills id. Returns undefined if not found (including a missing/undefined id: the postgres driver throws on an undefined parameter instead of returning an empty result). */
export async function getFrontendInvoice(billId: string | undefined | null): Promise<FrontendInvoice | undefined> {
  if (!billId) return undefined;
  const rows = await getSql()`SELECT * FROM vendor_bills WHERE id = ${billId}`;
  if (rows.length === 0) return undefined;
  return (await assemble(rows))[0];
}

/** The single-invoice view: everything in the list view plus what a reviewer needs to understand the case. */
export interface FrontendInvoiceDetail extends FrontendInvoice {
  /** Ordered vs received vs invoiced, line by line; null for an invoice with no purchase order. */
  threeWay: ThreeWay | null;
  /** Every reason code mapped to its plain name, so any code mentioned in a recorded claim can be named. */
  reasonNames: Record<string, string>;
}

export async function getFrontendInvoiceDetail(billId: string | undefined | null): Promise<FrontendInvoiceDetail | undefined> {
  if (!billId) return undefined;
  const sql = getSql();
  const rows = await sql`SELECT * FROM vendor_bills WHERE id = ${billId}`;
  if (rows.length === 0) return undefined;
  const bill = rows[0];
  const [view] = await assemble(rows);

  const reasonRows = await sql`SELECT code, name FROM reason_codes`;
  const reasonNames = Object.fromEntries(reasonRows.map((r: any) => [r.code as string, r.name as string]));

  let threeWay: ThreeWay | null = null;
  if (bill.po_id) {
    const [poRows, poLines, receipts, billLines] = await Promise.all([
      sql`SELECT po_number, status, po_type, currency, max_value_ceiling FROM purchase_orders WHERE id = ${bill.po_id}`,
      sql`SELECT id, line_number, description, uom, qty_ordered, unit_price, tolerance_pct FROM purchase_order_lines WHERE po_id = ${bill.po_id}`,
      sql`SELECT id, receipt_date, receiver_name, condition, final_delivery_indicator FROM goods_receipts WHERE po_id = ${bill.po_id} ORDER BY receipt_date`,
      sql`SELECT id, description, uom, qty_invoiced, unit_price FROM vendor_bill_lines WHERE vendor_bill_id = ${bill.id}`,
    ]);
    if (poRows.length > 0) {
      const receiptIds = receipts.map((r: any) => r.id);
      const receiptLines = receiptIds.length === 0 ? [] : await sql`SELECT goods_receipt_id, po_line_id, qty_received FROM goods_receipt_lines WHERE goods_receipt_id IN ${sql(receiptIds)}`;
      threeWay = buildThreeWay({ po: poRows[0] as any, poLines: poLines as any, receipts: receipts as any, receiptLines: receiptLines as any, billLines: billLines as any });
    }
  }
  return { ...view, threeWay, reasonNames };
}

export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 200;

/** Newest first, bounded (an unbounded list is a future outage). */
export async function listFrontendInvoices(opts: { limit?: number } = {}): Promise<FrontendInvoice[]> {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? DEFAULT_LIST_LIMIT), 1), MAX_LIST_LIMIT);
  const rows = await getSql()`SELECT * FROM vendor_bills ORDER BY received_at DESC LIMIT ${limit}`;
  return assemble(rows);
}
