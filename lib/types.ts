export type NodeId = 'extract'|'validate'|'match'|'investigate'|'verify'|'policy'|'audit'|'audit_assemble';
export type BillStatus = 'processing'|'matched'|'exception'|'approved'|'posted'|'paid'|'void';
export type ReviewAction = 'approve'|'reject'|'request_info'|'contest';
export type PbcItemType = 'trial_balance'|'ap_aging'|'invoice_bundle'|'tie_out_check'|'surl_check';
export type PbcStatus = 'open'|'assembled'|'submitted'|'accepted'|'exception';

export interface Vendor {
  id: string; name: string; remitToAddress?: string; bankAccountLast4?: string; bankAccountChangedAt?: string;
  trustTier: 'trusted'|'new'|'flagged'; taxId?: string; w9OnFile: boolean; paymentTermsCode?: string; createdAt: string;
}

export interface VendorCorrection {
  id: string; vendorId: string; pattern: string; note?: string; sourceInvoiceId?: string; createdAt: string;
  /** Only set when this correction records a confirmed UOM conversion factor (ALGORITHMS.md §14). */
  uomFrom?: string; uomTo?: string; conversionFactor?: number;
}

export interface TaxCode {
  id: string; name: string; rate: number; taxType: 'vat'|'gst'|'sales_tax'|'withholding';
  direction: 'input'|'output'; taxAccountId?: string; jurisdiction?: string; effectiveFrom: string; effectiveTo?: string;
}

export interface VendorBankChangeReview {
  id: string; vendorId: string; oldBankLast4?: string; newBankLast4?: string;
  status: 'callback_pending'|'callback_confirmed'|'callback_failed';
  callbackPhoneUsed?: string; callbackConfirmedBy?: string; callbackAt?: string;
  secondReviewerName?: string; sourceInvoiceId?: string; createdAt: string;
}

export interface PurchaseOrder {
  id: string; poNumber: string; vendorId: string; buyerName?: string; orderDate: string;
  status: 'open'|'partial'|'closed'; poType: 'standard'|'blanket';
  maxValueCeiling?: number; maxQtyCeiling?: number; currency: string; exchangeRate: number;
}

export interface PurchaseOrderLine {
  id: string; poId: string; lineNumber: number; description: string; uom: string;
  qtyOrdered: number; unitPrice: number; glAccountId?: string; tolerancePct: number; finalDelivery: boolean;
}

export interface GoodsReceipt {
  id: string; poId: string; receiptDate: string; receiverName?: string;
  condition: 'accepted'|'damaged'|'rejected'; finalDeliveryIndicator: boolean;
}

export interface VendorBill {
  id: string; vendorId: string; poId?: string; invoiceNumber: string; invoiceDate: string;
  totalAmount: number; currency: string; status: BillStatus; rawSource?: string;
  /** EXC-CREDIT_MEMO extension (spec §2 EXC-07) — 'standard' and no relatedInvoiceId for every ordinary bill. */
  invoiceType: 'standard'|'credit_memo'; relatedInvoiceId?: string;
}

export interface VendorBillLine {
  id: string; vendorBillId: string; poLineId?: string; description: string;
  qtyInvoiced: number; unitPrice: number; uom: string; taxCodeId?: string; glAccountId?: string;
  /** EXC-TAX_VAR extension — the tax actually charged on this line; undefined means no tax comparison fires. */
  taxAmount?: number;
}

export interface ToolCallLog { name: string; args: Record<string, unknown>; rawResult: unknown; resultHash: string; }
export interface Claim { text: string; tag: 'grounded'|'ungrounded'|'contradicted'; evidencePointer?: string; }
export interface PolicyEval { ruleId: string; threshold: number; actualValue: number; verdict: 'pass'|'fail'; }

export interface Decision {
  id: string; invoiceId?: string; nodeId: NodeId;
  parentDecisionId?: string; reconsiderationOfId?: string; supersededById?: string;
  agentId: string; model?: string; modelVersion?: string;
  startedAt: string; endedAt?: string;
  inputsConsumed?: Array<{source: string; retrievedAt: string; contentHash: string; reliedOnSpan?: string}>;
  toolCalls?: ToolCallLog[]; claims?: Claim[]; policyEvaluation?: PolicyEval[];
  confidence?: number; actionTaken?: string; reasonCode?: string;
  forwardedTo?: string; whatWasForwarded?: string;
  triggeredByActor?: string; triggeredByQuestion?: string;
  idempotencyKey?: string; prevHash?: string; hash: string; createdAt: string;
}

export interface ReviewInput { reviewerName: string; action: ReviewAction; reasonCode: string; note?: string; }
export interface Review extends ReviewInput { id: string; invoiceId: string; decisionId?: string; createdAt: string; }

export interface PbcRequest {
  id: string; itemType: PbcItemType; description: string; dueDate?: string;
  coveredPeriodId?: string; ownerName?: string; status: PbcStatus; linkedInvoiceIds?: string[];
}

// --- API request/response shapes ---
export interface CreateInvoiceRequest { rawSource: string; vendorId?: string; poId?: string; }
export interface CreateInvoiceResponse { id: string; status: BillStatus; }
export interface InvoiceDetailResponse { bill: VendorBill; decisions: Decision[]; }
export interface ExplainRequest { question: string; }
export interface ExplainResponse { answer: string; citedDecisionIds: string[]; grounded: boolean; }
export interface ReconsiderRequest { question: string; additionalContext?: string; }
export interface ReconsiderResponse { newDecision: Decision; cascaded: boolean; supersededDecisionIds: string[]; }
export interface DashboardResponse {
  strThroughRate: number; escalationRate: number; correctionsLearned: number;
  chainVerified: boolean; exceptionBreakdown: Record<string, number>;
}
