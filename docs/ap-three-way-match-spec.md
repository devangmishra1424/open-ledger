# 3-Way Match Engine — Technical Specification

**Version:** 1.0  
**Status:** Hackathon MVP Specification  
**Last Updated:** 2026-09-06

---

## Table of Contents

1. [Matching Logic](#1-matching-logic)
2. [Complete Exception Taxonomy](#2-complete-exception-taxonomy)
3. [Decision Matrix](#3-decision-matrix)
4. [Edge Cases & Precedence](#4-edge-cases--precedence)

---

## 1. Matching Logic

### 1.1 Document Model

```
Invoice
 ├── header (invoice_id, vendor_id, invoice_date, due_date, currency, tax_total, grand_total)
 └── line_items[]
      ├── line_id
      ├── description
      ├── po_number (nullable)
      ├── po_line_number (nullable)
      ├── quantity
      ├── unit_of_measure
      ├── unit_price
      ├── line_amount (qty × price)
      ├── tax_rate
      ├── tax_amount
      └── gl_account_code

PurchaseOrder
 ├── header (po_number, vendor_id, po_date, currency, total_amount)
 └── line_items[]
      ├── po_line_number
      ├── description
      ├── quantity
      ├── unit_of_measure
      ├── unit_price
      ├── line_amount
      └── tax_rate

GoodsReceipt
 ├── header (grn_number, po_number, receipt_date, carrier)
 └── line_items[]
      ├── po_line_number
      ├── quantity_received
      ├── quantity_accepted
      ├── quantity_rejected
      ├── unit_of_measure
      └── condition_notes
```

### 1.2 Pre-Match Validation (must pass before matching begins)

| Check | Rule | Failure Action |
|-------|------|----------------|
| Invoice readability | OCR confidence ≥ 85% OR structured input (XML/EDI) | EXC-LAYOUT |
| Duplicate check | No existing invoice with same `vendor_id + invoice_number` | EXC-DUPLICATE |
| Vendor active status | `vendor.status = 'ACTIVE'` and `vendor.approved = true` | Block, escalate to AP supervisor |
| Currency supported | `invoice.currency ∈ supported_currencies` | EXC-CURRENCY_MISMATCH |
| Invoice date validity | `invoice.invoice_date ≤ today + 1 day` AND `invoice.invoice_date ≥ today - 365 days` | Flag for review (anti-fraud) |
| Mandatory fields present | All required fields non-null per schema | EXC-LAYOUT |

### 1.3 Header-Level Matching Rules

| Field | Match Rule | Tolerance | Notes |
|-------|-----------|-----------|-------|
| **Vendor ID** | Exact match: `invoice.vendor_id == po.vendor_id` | None | Mismatch → EXC-NO_PO |
| **Currency** | Exact match: `invoice.currency == po.currency == grn.currency` | None | Mismatch → EXC-CURRENCY |
| **PO Reference** | Invoice references valid, open PO number | N/A | Missing → EXC-NO_PO |
| **Invoice Date** | `invoice.invoice_date ≤ grn.receipt_date + 7 days` | 7 days grace | Late receipt → EXC-INVOICE_BEFORE_RECEIPT |

### 1.4 Line-Level Matching Rules

#### 1.4.1 PO ↔ Invoice Line Matching

The engine matches invoice lines to PO lines using a **greedy assignment algorithm**:

1. **Primary key:** `(po_line_number)` — direct reference match
2. **Fallback key:** `(description_similarity ≥ 85% AND unit_of_measure match)` — fuzzy match
3. **Quantity check:** `abs(invoice_line.quantity - po_line.quantity) / po_line.quantity ≤ 0.05` (5%)
4. **Unit price check:** `abs(invoice_line.unit_price - po_line.unit_price) / po_line.unit_price ≤ 0.02` (2%)
5. **Amount check:** `abs(invoice_line.line_amount - (po_line.unit_price × invoice_line.quantity)) ≤ $50.00 OR ≤ 2%`

#### 1.4.2 PO ↔ GRN Line Matching (Quantity Confirmation)

| Field | Rule | Tolerance |
|-------|------|-----------|
| **Quantity** | `invoice_line.quantity ≤ grn.quantity_accepted` | 0% — must not exceed accepted qty |
| **Unit of Measure** | Exact match: `invoice_line.UoM == grn_line.UoM` | None |
| **Received date** | `grn.receipt_date ≤ invoice.invoice_date` | 0% |

#### 1.4.3 Amount Matching (Grand Total)

```
total_variance = abs(invoice.grand_total - po.total_amount)
tolerance_abs  = $100.00
tolerance_pct  = 3.0%

IF total_variance ≤ tolerance_abs
   → PASS (auto-match)
ELSE IF total_variance / po.total_amount ≤ tolerance_pct
   → PASS (auto-match)
ELSE IF total_variance ≤ $500.00
   → EXC-PRICE_VAR (escalate L1)
ELSE
   → EXC-PRICE_VAR (block)
```

### 1.5 Tolerance Thresholds Summary

| Dimension | Green Zone (Auto-Match) | Yellow Zone (Escalate) | Red Zone (Block) |
|-----------|------------------------|----------------------|------------------|
| **Unit price variance** | ≤ 2.0% | 2.01% – 5.0% | > 5.0% |
| **Quantity variance** | ≤ 5.0% (and ≤ 2 units) | 5.01% – 15.0% | > 15.0% |
| **Line amount variance** | ≤ $50.00 OR ≤ 2% | $50.01 – $200.00 | > $200.00 |
| **Grand total variance** | ≤ $100.00 OR ≤ 3% | $100.01 – $500.00 | > $500.00 |
| **Tax rate variance** | ≤ 0.5% (absolute) | 0.51% – 2.0% | > 2.0% |
| **Date gap** | ≤ 3 days | 3 – 7 days | > 7 days |

### 1.6 Partial Match Handling

#### Scenario A: Partial Shipment (PO has 100 units, GRN shows 70 received, invoice bills for 70)

```
Match result: PARTIAL_MATCH
matched_qty   = 70
open_qty      = 30  (remains on PO)
action        → Pay invoice for 70 units (line-level match)
                Flag PO as partially received
                Remaining PO lines remain open
```

#### Scenario B: Split Invoice (Single PO line invoiced across 2 invoices)

```
Invoice 1: qty = 60  → matches PO line, partial match, open = 40
Invoice 2: qty = 40  → matches PO line, full match, PO line closed
Duplicate check: Invoice 2 must reference same PO line, qty_invoiced
                 on PO line tracked: 60 + 40 = 100 ✓
```

#### Scenario C: Over-Invoice (Invoice qty > GRN qty)

```
Invoice: 120 units
GRN:     100 units
PO:      150 units

Match result: QUANTITY_EXCEPTION
matched_qty   = 100 (what was actually received)
excess_qty    = 20
action        → Block excess 20 units
                Pay for 100 units only
                Raise EXC-QTY_VAR for the 20-unit delta
```

### 1.7 Many-to-Many Line Matching

| Scenario | Algorithm |
|----------|-----------|
| **1 invoice line → N PO lines** | Split the invoice line amount proportionally across matched PO lines by quantity. Each sub-match must independently pass tolerance checks. |
| **N invoice lines → 1 PO line** | Sum all matching invoice line amounts. Total must not exceed PO line amount × 1.02 (2% tolerance). Each invoice line must have a valid reference or fuzzy match. |
| **N invoice lines → M PO lines** | Hungarian algorithm (min-cost matching) on a cost matrix where `cost[i][j]` = `abs(invoice_line[i].line_amount - po_line[j].line_amount)` if matchable, else `∞`. Maximize total matched amount subject to tolerance constraints. |

---

## 2. Complete Exception Taxonomy

### EXC-01: Missing PO Reference

| Attribute | Detail |
|-----------|--------|
| **Code** | `EXC-NO_PO` |
| **Name** | Missing Purchase Order |
| **Detection Logic** | `invoice.po_number IS NULL` OR `invoice.po_number` does not exist in PO master table OR PO status ∉ `{APPROVED, OPEN, PARTIALLY_RECEIVED}` |
| **Severity** | **Escalate L2** (always — never auto-resolve) |
| **Resolution Action** | Route to AP supervisor for manual PO lookup or retroactive PO creation. If vendor is on whitelist for non-PO purchases < $2,500, route to L1. |
| **Example** | Invoice #INV-4821 from Acme Corp, $3,200, no PO number provided. AP supervisor contacts purchasing to locate PO-2024-0892 or requests retroactive PO. |

### EXC-02: Invoice Before Receipt

| Attribute | Detail |
|-----------|--------|
| **Code** | `EXC-BEFORE_RCV` |
| **Name** | Invoice Received Before Goods Receipt |
| **Detection Logic** | For all matched PO lines: `invoice.invoice_date < grn.receipt_date` AND no GRN exists yet. Specifically: `matched_grn_lines.count = 0` OR `invoice.invoice_date < MIN(grn.receipt_date) - grace_period` |
| **Severity** | **Block** if GRN not yet created; **Escalate L1** if GRN exists but receipt_date > invoice_date by > 7 days |
| **Resolution Action** | Hold invoice in queue. Set SLA: if GRN not received within 15 business days, auto-escalate to L2. Notify purchasing team. |
| **Example** | Invoice #INV-5502 dated 2026-09-01 for PO-2024-1100. GRN not yet created. Invoice held. On 2026-09-22 (15 business days later), auto-escalated to purchasing director. |

### EXC-03: Price Variance

| Attribute | Detail |
|-----------|--------|
| **Code** | `EXC-PRICE_VAR` |
| **Name** | Unit Price Variance Exceeds Tolerance |
| **Detection Logic** | `abs(invoice_line.unit_price - po_line.unit_price) / po_line.unit_price > 0.02` (2% threshold) |
| **Severity** | 2.01%–5.0%: **Escalate L1**; > 5.0% OR variance > $50/line: **Block** |
| **Resolution Action** | L1: Buyer confirms price change (contract amendment, spot price adjustment). L2: Buyer + Finance review. If price increase > $500 total, require VP approval. |
| **Example** | PO-2024-0555 Line 3: widget at $45.00. Invoice #INV-6001 charges $47.25 (5.0% variance). Blocked. Buyer confirms new contract rate effective 2026-09-01. Price updated, invoice released. |

### EXC-04: Quantity Variance

| Attribute | Detail |
|-----------|--------|
| **Code** | `EXC-QTY_VAR` |
| **Name** | Invoiced Quantity ≠ Received Quantity |
| **Detection Logic** | `invoice_line.quantity > grn.quantity_accepted` OR `grn.quantity_accepted < po_line.quantity` AND `invoice_line.quantity == po_line.quantity` (invoice bills for full PO but only partial received) |
| **Severity** | Invoice qty > GRN qty by ≤ 5%: **Escalate L1**; > 5% OR > 2 units: **Block** |
| **Resolution Action** | Pay only for quantity actually accepted. Raise debit note request for overage. If shortage, flag PO for backorder follow-up. |
| **Example** | PO-2024-0700: 200 units. GRN-8842: 190 received, 188 accepted (2 damaged). Invoice: 200 units. **Blocked.** Pay for 188. Debit note for 12 units ($540) issued to vendor. |

### EXC-05: Duplicate Invoice

| Attribute | Detail |
|-----------|--------|
| **Code** | `EXC-DUPLICATE` |
| **Name** | Duplicate Invoice Detected |
| **Detection Logic** | `EXISTS (existing_invoice WHERE existing_invoice.vendor_id = invoice.vendor_id AND existing_invoice.invoice_number = invoice.invoice_number)` OR fuzzy duplicate: same vendor + same amount ±$1 + same date ±1 day + similar line items (cosine similarity ≥ 0.90) |
| **Severity** | **Block** (always — no exceptions) |
| **Resolution Action** | Reject incoming invoice. Log duplicate attempt for audit. If first instance was a processing error (e.g., rejected), allow override with AP manager approval + documented reason code. |
| **Example** | Invoice #INV-7023 from Beta Supplies, $8,750, received 2026-09-03. Identical invoice #INV-7023 received again on 2026-09-04. **Blocked.** Logged as duplicate. Vendor notified. |

### EXC-06: Non-PO Invoice

| Attribute | Detail |
|-----------|--------|
| **Code** | `EXC-NON_PO` |
| **Name** | Non-Purchase Order Invoice |
| **Detection Logic** | `invoice.invoice_type = 'NON_PO'` OR (invoice.po_number IS NULL AND invoice.vendor ∉ non_po_vendor_whitelist) OR (invoice.total_amount > vendor.non_po_limit) |
| **Severity** | ≤ $2,500 and vendor whitelisted: **Auto-approve** (with GL coding); ≤ $10,000: **Escalate L1**; > $10,000: **Escalate L2** |
| **Resolution Action** | Require GL account coding from requester. L1: Manager approval. L2: Director + Finance approval. Attach cost center and budget code before payment. |
| **Example** | Invoice #INV-8100 from Gamma Consulting, $6,500 for "Q3 advisory services." No PO. Escalated to L1. Manager approves, assigns GL 6100-4500 (consulting expense, Marketing dept). Paid. |

### EXC-07: Credit Memo Netting

| Attribute | Detail |
|-----------|--------|
| **Code** | `EXC-CREDIT_MEMO` |
| **Name** | Credit Memo Requires Netting |
| **Detection Logic** | `invoice.invoice_type = 'CREDIT_MEMO'` AND `credit_memo.related_invoice_number` references an existing paid/partially-paid invoice |
| **Severity** | **Auto-resolve** if net_amount ≥ 0 after netting; **Escalate L1** if net_amount < 0 (vendor owes us) |
| **Resolution Action** | Auto-net against related invoice. If credit exceeds original invoice, hold excess as vendor credit balance. Issue vendor credit balance statement. |
| **Example** | Original invoice #INV-3000: $10,000 (paid). Credit memo #CM-2001: -$1,500 for returned goods. Net: -$1,500 credit applied. Vendor balance: credit of $1,500. Applied to next invoice from same vendor. |

### EXC-08: Partial Payment / Partial Shipment

| Attribute | Detail |
|-----------|--------|
| **Code** | `EXC-PARTIAL` |
| **Name** | Partial Shipment or Partial Payment Required |
| **Detection Logic** | `grn.quantity_accepted < po_line.quantity` AND `invoice_line.quantity ≤ po_line.quantity` AND `invoice_line.quantity > grn.quantity_accepted` (invoice covers full PO but only partial received). OR: invoice explicitly marks as partial (`invoice.is_partial = true`). |
| **Severity** | **Auto-resolve** (partial matching is expected behavior) |
| **Resolution Action** | Create partial payment for matched quantity. Track open balance on PO. Auto-generate backorder alert if GRN not received within PO lead time + 10 days. |
| **Example** | PO-2024-0900: 500 units. GRN-9901: 300 received. Invoice #INV-9200: 300 units. **Matched.** Pay for 300. PO open balance: 200 units. Backorder alert scheduled for 2026-09-20. |

### EXC-09: Currency Mismatch

| Attribute | Detail |
|-----------|--------|
| **Code** | `EXC-CURRENCY` |
| **Name** | Currency Mismatch Between Documents |
| **Detection Logic** | `invoice.currency ≠ po.currency` OR `po.currency ≠ grn.currency` OR `invoice.currency` not in `supported_currencies[]` |
| **Severity** | Invoice currency not supported: **Block**; Invoice currency ≠ PO currency but both supported: **Escalate L2** |
| **Resolution Action** | If supported mismatch: Convert invoice to PO currency using ECB rate on invoice date. Tolerance: ±1% of converted amount. If not supported: Reject and notify vendor to re-issue in supported currency. |
| **Example** | PO-2024-1200 in EUR. Invoice #INV-1050 submitted in GBP. GBP→EUR rate on invoice date: 1.1650. Invoice €5,825.00. PO total: €5,750. Variance: 1.3% — within 2% tolerance for FX. **Escalate L1** for rate confirmation, then auto-approve. |

### EXC-10: Tax Mismatch

| Attribute | Detail |
|-----------|--------|
| **Code** | `EXC-TAX_VAR` |
| **Name** | Tax Rate or Tax Amount Mismatch |
| **Detection Logic** | `abs(invoice_line.tax_rate - po_line.tax_rate) > 0.5%` OR `abs(invoice_line.tax_amount - (po_line.tax_rate × invoice_line.line_amount)) > $10.00` OR tax jurisdiction mismatch |
| **Severity** | Rate diff ≤ 2.0%: **Escalate L1**; Rate diff > 2.0% OR tax amount diff > $100: **Block** |
| **Resolution Action** | L1: Verify correct tax jurisdiction and rate. Common fix: tax-exempt certificate not on file, or new tax rate effective date mismatch. L2: Finance/Tax team review. |
| **Example** | PO-2024-0600: 8.25% sales tax (Texas). Invoice #INV-6500: 10.00% (wrong — vendor applied California rate). Tax variance: 1.75%. **Escalate L1.** AP corrects to 8.25%, notifies vendor of tax rate, vendor issues credit memo for $212.50 overage. |

### EXC-11: Bad/Unreadable Invoice Layout

| Attribute | Detail |
|-----------|--------|
| **Code** | `EXC-LAYOUT` |
| **Name** | Invoice Cannot Be Parsed or Is Unreadable |
| **Detection Logic** | OCR confidence < 85% OR structured parser returns ≥ 3 required fields as null OR document format ∉ {PDF, XML, EDI, CSV, PNG, TIFF} OR file size > 10MB OR page count > 50 |
| **Severity** | **Block** (hard block — cannot proceed without parseable data) |
| **Resolution Action** | Route to manual entry queue. If OCR confidence 60–84%, attempt secondary OCR pass with enhanced preprocessing. Notify vendor of format non-compliance with preferred format guidelines. |
| **Example** | Invoice #INV-1101 scanned at 72 DPI, OCR confidence 68%. Text garbled in line item section. **Blocked.** Sent to manual entry. AP clerk enters data from original document. Vendor added to "format compliance" mailing list. |

### EXC-12: Vendor Bank Detail Change (Fraud Flag)

| Attribute | Detail |
|-----------|--------|
| **Code** | `EXC-FRAUD_BANK` |
| **Name** | Vendor Bank Details Changed — Potential Fraud |
| **Detection Logic** | `invoice.payment_details.bank_account ≠ vendor.registered_bank_account` OR `invoice.payment_details.routing_number ≠ vendor.registered_routing_number` OR vendor bank details updated within last 30 days AND invoice amount > $5,000 |
| **Severity** | **Block + Fraud Flag** (hard block, mandatory dual approval to override) |
| **Resolution Action** | Hold payment immediately. Trigger fraud alert to AP manager + treasury + information security. Require out-of-band verification: phone call to vendor's registered contact + email confirmation from vendor's domain. Dual sign-off by AP manager + CFO for release. |
| **Example** | Vendor Delta Manufacturing (trusted, 3-year relationship). Bank details changed 2026-08-25 from Chase ending ****4521 to unknown Wells Fargo ****7890. Invoice #INV-1200 for $12,500 submitted 2026-09-02. **Blocked. Fraud flag raised.** Phone verification confirms change is legitimate (vendor acquired). CFO approves. Payment released 2026-09-05. |

---

## 3. Decision Matrix

### 3.1 Core Decision Table

| Exception Type | Auto-Approve | Auto-Reject | Escalate L1 | Escalate L2 | Block & Flag |
|---------------|:---:|:---:|:---:|:---:|:---:|
| **EXC-NO_PO** (Missing PO) | — | — | — | ✓ (always) | — |
| **EXC-BEFORE_RCV** (Invoice Before Receipt) | — | — | ✓ (GRN exists, >7d gap) | — | ✓ (no GRN yet) |
| **EXC-PRICE_VAR** (Price Variance) | — | — | ✓ (2–5% OR ≤$500) | — | ✓ (>5% OR >$500) |
| **EXC-QTY_VAR** (Quantity Variance) | — | — | ✓ (≤5% AND ≤2 units) | — | ✓ (>5% OR >2 units) |
| **EXC-DUPLICATE** (Duplicate Invoice) | — | ✓ (always) | — | — | — |
| **EXC-NON_PO** (Non-PO Invoice) | ✓ (≤$2,500 + whitelisted) | — | ✓ ($2,501–$10K) | ✓ (>$10K) | — |
| **EXC-CREDIT_MEMO** (Credit Memo Netting) | ✓ (net ≥ $0) | — | ✓ (net < $0) | — | — |
| **EXC-PARTIAL** (Partial Payment) | ✓ (always) | — | — | — | — |
| **EXC-CURRENCY** (Currency Mismatch) | — | — | ✓ (rate variance ≤1%) | ✓ (rate variance >1%) | ✓ (unsupported currency) |
| **EXC-TAX_VAR** (Tax Mismatch) | — | — | ✓ (rate diff ≤2%) | — | ✓ (rate diff >2% OR amount >$100) |
| **EXC-LAYOUT** (Unreadable Invoice) | — | — | — | — | ✓ (always) |
| **EXC-FRAUD_BANK** (Bank Detail Change) | — | — | — | — | ✓ (always + fraud flag) |

### 3.2 Dollar-Threshold Severity Escalation

These dollar thresholds **override** the percentage-based rules above when the absolute dollar impact is significant.

| Exception Type | ≤ $100 | $101 – $1,000 | $1,001 – $10,000 | $10,001 – $50,000 | > $50,000 |
|---------------|:---:|:---:|:---:|:---:|:---:|
| **EXC-PRICE_VAR** | Auto-approve | Escalate L1 | Escalate L1 | Escalate L2 | Block → CFO |
| **EXC-QTY_VAR** | Auto-approve | Escalate L1 | Escalate L1 | Escalate L2 | Block → CFO |
| **EXC-TAX_VAR** | Auto-approve | Escalate L1 | Escalate L2 | Block | Block → CFO |
| **EXC-NON_PO** | Auto-approve | Escalate L1 | Escalate L2 | Block → Finance | Block → CFO |
| **EXC-CURRENCY** | Auto-approve | Escalate L1 | Escalate L1 | Escalate L2 | Block → Treasury |
| **EXC-BEFORE_RCV** | Escalate L1 | Escalate L1 | Escalate L2 | Block | Block → VP |

**Rule:** When dollar thresholds and percentage thresholds disagree, the **more restrictive** (higher severity) action wins.

### 3.3 Action Definitions

| Action | SLA | Approver(s) | System Behavior |
|--------|-----|-------------|-----------------|
| **Auto-Approve** | Immediate | System (no human) | Invoice queued for payment run |
| **Auto-Reject** | Immediate | System | Invoice rejected, vendor notified, audit logged |
| **Escalate L1** | 2 business days | AP Clerk / AP Analyst | Notification sent, invoice held in queue |
| **Escalate L2** | 3 business days | AP Manager / Finance Controller | Notification + email, invoice held, aging clock starts |
| **Block** | Indefinite (until resolved) | AP Manager + Functional Owner | Payment frozen, vendor notified, requires resolution to proceed |
| **Block + Fraud Flag** | Immediate escalation | AP Manager + CFO + InfoSec | Payment frozen, fraud team engaged, vendor account frozen pending investigation |

---

## 4. Edge Cases & Precedence

### 4.1 Co-Occurring Exceptions

When multiple exceptions are detected on a single invoice, they are **all logged independently**, but the invoice's overall action is determined by the **highest-severity** exception.

#### Example: Invoice with 3 simultaneous exceptions

```
Invoice #INV-9999, Vendor Acme Corp, $25,000

Exceptions detected:
  1. EXC-PRICE_VAR:  Unit price 7.2% above PO → Block (>5%)
  2. EXC-QTY_VAR:    Qty invoiced 200, received 190 → 5.3% → Block (>5%)
  3. EXC-TAX_VAR:    Tax rate 2.5% mismatch → Block (>2%)

Overall action: BLOCK (highest severity among all exceptions)
Resolution required: ALL three exceptions must be resolved before release
```

### 4.2 Precedence Rules for Overlapping Exceptions

When exceptions overlap conceptually, apply these precedence rules in order:

| Priority | Rule | Rationale |
|:---:|------|-----------|
| **1 (highest)** | `EXC-FRAUD_BANK` always wins — no override allowed | Fraud must be investigated regardless of other factors |
| **2** | `EXC-DUPLICATE` blocks even if other exceptions would auto-approve | Never pay a duplicate, even if it matches perfectly |
| **3** | `EXC-LAYOUT` blocks — cannot process what cannot be read | Data quality is foundational |
| **4** | `EXC-NO_PO` / `EXC-NON_PO` takes precedence over matching exceptions | Cannot match without a valid PO to match against |
| **5** | `EXC-CURRENCY` blocks until resolved — conversion must happen before amount matching | Amounts are meaningless without currency alignment |
| **6** | `EXC-BEFORE_RCV` blocks until GRN exists | Cannot validate quantity without receipt confirmation |
| **7 (lowest)** | `EXC-PRICE_VAR`, `EXC-QTY_VAR`, `EXC-TAX_VAR` — resolved by matching engine within tolerance or escalated | These are "normal" matching exceptions |

### 4.3 Exception Cascade Rules

```
IF EXC-LAYOUT detected:
    → STOP. Do not attempt matching. All other exceptions deferred.
    → After layout resolved → re-run full detection pipeline.

IF EXC-DUPLICATE detected:
    → STOP. Do not proceed to matching.
    → After duplicate cleared → re-run full detection pipeline.

IF EXC-FRAUD_BANK detected:
    → STOP. Fraud investigation takes priority.
    → All payment actions frozen.
    → Other exceptions logged but NOT actionable until fraud cleared.

IF EXC-NO_PO detected:
    → STOP matching. Cannot proceed without PO.
    → After PO assigned → re-run from matching step.

Otherwise:
    → Run full matching pipeline.
    → Collect ALL exceptions.
    → Apply highest-severity rule.
```

### 4.4 Multi-Invoice, Single PO Edge Cases

| Scenario | Behavior |
|----------|----------|
| 2 invoices for same PO line, total qty = PO qty | Both matched. First pays, second pays. PO line closed. |
| 2 invoices for same PO line, total qty > PO qty | First matched. Second flagged EXC-QTY_VAR for excess. Excess rejected. |
| 3 invoices for same PO, each partial | All three matched independently against PO lines. PO tracks cumulative invoiced qty. When invoiced qty = PO qty, PO line marked "fully invoiced." |
| Invoice references PO that was cancelled | EXC-NO_PO (PO status ≠ approved/open). Blocked. |

### 4.5 Rounding and Precision Rules

| Rule | Detail |
|------|--------|
| **Currency precision** | Match to currency's minor unit (USD/EUR/GBP: 2 decimals; JPY: 0 decimals) |
| **Variance calculation** | Always compute from PO as denominator: `(invoice - po) / po` |
| **Tie-breaking** | When variance is exactly at threshold boundary (e.g., 2.000%), classify as **green zone** (auto-approve) |
| **Aggregation** | Line-level variances do NOT aggregate into a single pass/fail. Each line is evaluated independently. Header-level total is a separate check. |

### 4.6 Re-Processing Rules

| Trigger | Behavior |
|---------|----------|
| GRN arrives after invoice blocked for EXC-BEFORE_RCV | Auto-retry matching. If now within tolerance → release to payment. If still outside tolerance → keep exception, re-classify (e.g., now EXC-QTY_VAR). |
| Price corrected by vendor (credit memo + new invoice) | Old invoice closed with credit memo. New invoice runs fresh through matching. |
| OCR re-process succeeds | Re-run full pipeline from pre-match validation. |
| Bank details re-verified as legitimate | Remove EXC-FRAUD_BANK flag. Invoice re-enters normal queue. |

---

## Appendix: Exception Code Quick Reference

| Code | Name | Severity | Auto-Action |
|------|------|----------|-------------|
| `EXC-NO_PO` | Missing PO | Escalate L2 | Hold + notify |
| `EXC-BEFORE_RCV` | Invoice Before Receipt | Block / Escalate L1 | Hold + SLA timer |
| `EXC-PRICE_VAR` | Price Variance | Escalate L1 / Block | Hold |
| `EXC-QTY_VAR` | Quantity Variance | Escalate L1 / Block | Hold + debit note |
| `EXC-DUPLICATE` | Duplicate Invoice | Auto-Reject | Reject + log |
| `EXC-NON_PO` | Non-PO Invoice | Variable by amount | Route for approval |
| `EXC-CREDIT_MEMO` | Credit Memo Netting | Auto-Resolve / Escalate L1 | Net automatically |
| `EXC-PARTIAL` | Partial Payment | Auto-Resolve | Pay matched qty |
| `EXC-CURRENCY` | Currency Mismatch | Escalate L1-L2 / Block | Convert or reject |
| `EXC-TAX_VAR` | Tax Mismatch | Escalate L1 / Block | Hold + verify |
| `EXC-LAYOUT` | Unreadable Invoice | Block | Route to manual entry |
| `EXC-FRAUD_BANK` | Bank Detail Change | Block + Fraud Flag | Freeze + investigate |

---

*End of specification. For implementation, each exception type should have a dedicated detector class implementing a common `ExceptionDetector` interface with `detect(invoice, po, grn) → List<Exception>`.*
