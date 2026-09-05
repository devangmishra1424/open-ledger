# Open Ledger — Complete Design Document (v1, pre-build)

Status: design-locked draft, awaiting team review and an Opus audit pass before any further code is written. This supersedes the narrower build notes in SPEC.md — SPEC.md will be rewritten from this once the team signs off.

---

## 0. The pitch, in one paragraph

Open Ledger is an Accounts-Payable agent that runs the industry-standard 3-way match (Purchase Order ↔ Goods Receipt ↔ Invoice) with a genuinely comprehensive, closed exception taxonomy — and unlike every funded competitor in this space, it is not a black box: every agent, every handoff, every decision is individually interrogable, contestable, and backed by an accounting-correct, append-only ledger, so the explanation can never diverge from what actually happened. It is scoped as the "hero workflow" inside the real Procure-to-Pay cycle, and it is deliberately built to show — not just claim — where that cycle hands off into Record-to-Report (month-end close), Treasury, and Audit, even though it only fully automates the P2P slice.

---

## 1. Product scope — what we build, what we don't, and why

**In scope, built for real:** the full AP invoice lifecycle from invoice arrival through 3-way match, exception handling, tiered human review, GL posting, and payment scheduling — for one legal entity, one currency-capable but single-currency demo dataset, a compact chart of accounts, and a closed, engineered set of exception scenarios (see §6).

**Explicitly out of scope, but acknowledged and visually connected (not ignored):** full month-end close (R2R), Order-to-Cash, full Treasury cash forecasting, live bank/ERP integration, real OCR on arbitrary documents, real payment execution. Each of these is where our hero workflow's outputs *would* flow in a real deployment, and the product should say so explicitly rather than pretend AP exists in isolation — see §2 and Screen G.

**Why AP 3-way match specifically (recap, not re-derived):** it is the one workflow among the six CFO-office candidates with a closed, finite, practitioner-documented exception taxonomy (research turned up 30+ real, named edge cases, not just the 12 we started with — see §6), which makes "we handle every case" a falsifiable claim rather than a marketing platitude. It is also the one the hackathon's own judges (Maximor) build their product pitch around almost verbatim.

---

## 2. Where the hero workflow sits in the real finance ecosystem

Real corporate finance runs on a small number of standard process chains, and they interlock at specific, named points — this is not incidental context, it's what makes a reviewer trust that we understand the domain rather than having invented a toy.

- **Procure-to-Pay (P2P)** — our hero workflow: Requisition → PO → Goods Receipt → Invoice → 3-way Match → Approval → Payment → GL Posting → PO Closure.
- **Record-to-Report (R2R)** — month-end close: transaction posting → sub-ledger close → reconciliation → adjusting entries → trial balance → consolidation → financial statements → management review → period lock.
- **Order-to-Cash (O2C)** — the mirror-image revenue cycle (out of scope, acknowledged for completeness only).
- **Treasury / Cash Management** — daily cash positioning, bank reconciliation, 13-week forecasting.
- **Audit support (PBC)** — pulls evidence from all of the above.

**The exact handoff points our product should be visibly aware of:**

1. **P2P → R2R, via the GR/IR clearing account.** A goods receipt posts an accrual (Dr Inventory/Expense, Cr GR/IR clearing) before the invoice even arrives; the invoice posting clears it (Dr GR/IR, Cr AP). R2R's month-end close literally reconciles the GR/IR account's balance against P2P's own "received but not yet invoiced" aging report. **We model the GR/IR clearing account as a real GL account in our chart of accounts and post to it correctly**, even though we don't build the R2R reconciliation screen — this is what lets the numbers be right if someone extended the product tomorrow.
2. **P2P → R2R, via the AP-subledger-to-GL tie-out.** Practitioners call this "the single most important control in the AP close." Our schema keeps the AP subledger (open vendor_bills) and the GL control account (2000 Accounts Payable) as genuinely separate structures that must sum to the same number — and we ship a small script/report that proves they tie out, as a stand-in for the real R2R reconciliation task.
3. **P2P → R2R, the exception that matching alone can't catch.** A cleanly-3-way-matched invoice from an unusual or newly-active vendor doesn't get re-examined by the matching engine — in a real close it only resurfaces during flux/variance analysis, when a controller traces an unexplained spike back to it. Our dashboard's exception-type breakdown and vendor-trust-tier signals are the seed of that same capability.
4. **P2P → Treasury**, via the payment proposal (Treasury needs visibility into a pending payment run to fund the account) and positive-pay (a cleared payment without a matching positive-pay record is a fraud signal). We stub payment scheduling with these fields even before Dodo Payments is wired in.
5. **R2R/P2P → Audit**, via the trial balance (the literal first PBC artifact) and the "search for unrecorded liabilities" procedure, which tests exactly the P2P→R2R accrual handoff above. Our audit-trail viewer (§9, Screen E) is designed to answer the same question an auditor asks: for this GL balance, show me every transaction and every decision that produced it.

**Terminal state is two different things, and the product must model both**, per the research's explicit design warning: an invoice-lifecycle terminal state (matched or resolved, posted, paid, PO line closed) is not the same object as a period-terminal state (every invoice dated before cutoff captured, GR/IR reconciled, AP subledger tied to GL, accruals booked for the rest). We build the former fully; we build a lightweight, honest stand-in for the latter (§9, Screen G and a simple "period health" panel) rather than pretending it doesn't exist.

---

## 3. Roles & personas

Real AP touches roughly a dozen distinct roles (requester, buyer/procurement, receiving clerk, AP clerk, AP team lead, AP manager, controller, treasury/payment-ops, CFO, tax team, internal audit, IT/ERP admin, the vendor, external auditors). We do not build a UI for all of them — that would be scope creep the hosts explicitly warned against. We model:

- **AP clerk / reviewer** (the primary demo persona) — picked from a fixed name list, no real accounts (§ Build notes).
- **AP manager / controller** (a second reviewer tier, for tier-2 escalations and segregation-of-duties demonstration).
- **The agent itself**, as a named, accountable actor in the decision ledger — not an anonymous "system."

Everyone else (buyer, receiving clerk, treasury, tax, internal audit, vendor, external auditor) is *acknowledged in the data model* (e.g., a goods receipt has a receiver field, a vendor bank-change has a callback-verification field) so the schema doesn't collapse real-world structure, but they don't get dedicated screens in v1.

---

## 4. Novel differentiators (crystallized)

1. **Closed-loop, not anomaly-flagging.** Every competitor found in research (Brex's Agent Mesh, BlackLine's Verity, Fieldguide's multi-agent PBC pipeline) *describes* a full detect→resolve→post loop in a press release; none show it as a live, inspectable interface. We show it, live, invoice by invoice.
2. **Genuinely not a black box.** Every node is individually interrogable (a retrieval-only "ask why" popover, constrained to that node's own recorded evidence — never a general chatbot that can invent a plausible-sounding but false justification), every claim carries a citation to an immutable record, and contesting a decision is a first-class, logged action — not a comment box.
3. **A tool-calling investigative agent, not a hardcoded pipeline.** The exception-classification step decides what evidence to gather (PO, receipts, vendor history, duplicate check) the way a real AP clerk investigates, and it genuinely learns per-vendor over time (a correction on one invoice changes how the next invoice from that vendor is handled) — a real memory loop, demoable live.
4. **Accounting-correct under the hood.** Real double-entry journal entries (two separate entries — bill approval and payment — never one mutable "status" flag), a real chart of accounts, real tax and multi-currency modeling, an append-only ledger that mirrors how actual ERPs work — so a real controller reviewing this would recognize the structure, not wince at it.
5. **Ecosystem-aware, not workflow-isolated.** The product visibly shows where AP sits inside Procure-to-Pay and hands off into close, treasury, and audit, instead of pretending AP exists in a vacuum.

---

## 5. Database schema (accounting-correct, event-sourced ledger)

### 5.1 Core reference / master data
- **`chart_of_accounts`**: account_id, account_number, name, account_type (asset/liability/equity/revenue/expense), account_subtype, normal_balance (debit/credit), parent_account_id, is_control_account (bool — flags 2000 Accounts Payable and the GR/IR clearing account), currency (nullable), is_active.
  - Seeded per the standard 4-digit demo range: 1000s Assets (1000 Operating Checking, 1300 Prepaid Expenses, 1500s Fixed Assets), 2000s Liabilities (**2000 Accounts Payable — control account**, **2050 GR/IR Clearing**, 2200 VAT/Sales Tax Payable, 2210 VAT Recoverable), 3000s Equity, 4000s Revenue (unused in v1), 5000 COGS, 6000s Operating Expenses (6000 Office Supplies … 6900 Depreciation — where AP bills land), 7000s Other (7100 Interest Expense, 7200/7210 Realized/Unrealized FX Gain-Loss).
- **`accounting_periods`**: period_id, name (e.g. "2026-09"), start_date, end_date, status (open/closed/permanently_closed).
- **`vendors`**: vendor_id, name, remit_to_address, bank_account_last4, bank_account_changed_at (nullable), trust_tier (trusted/new/flagged), tax_id, w9_on_file (bool), payment_terms_code (e.g. "2/10 NET 30"), created_at.
- **`vendor_corrections`** (the learning-loop memory store): id, vendor_id, pattern, note, source_invoice_id, created_at.
- **`tax_codes`**: tax_code_id, name, rate, tax_type (vat/gst/sales_tax/withholding), direction (input/output), tax_account_id (FK to chart_of_accounts), jurisdiction, effective_from, effective_to (nullable — never mutate a rate in place).
- **`exchange_rates`** (only needed if the demo includes a foreign-currency vendor): from_currency, to_currency, rate, rate_date, rate_source.

### 5.2 The P2P subledger documents
- **`purchase_orders`**: po_id, vendor_id, buyer_name, order_date, status (open/partial/closed), currency, exchange_rate.
- **`purchase_order_lines`**: id, po_id, line_number, description, uom, qty_ordered, unit_price, gl_account_id, tolerance_pct (e.g. 2%), final_delivery (bool, set by the last goods receipt against this line).
- **`goods_receipts`**: id, po_id, receipt_date, receiver_name, condition (accepted/damaged/rejected), final_delivery_indicator (bool).
- **`goods_receipt_lines`**: id, goods_receipt_id, po_line_id, qty_received.
- **`vendor_bills`** (the "invoice" object): id, vendor_id, po_id (nullable — null means non-PO), invoice_number, invoice_date, due_date, currency, exchange_rate, subtotal, tax_total, total_amount, raw_source (text — structured JSON or extracted PDF/email text), ap_account_id (FK to chart_of_accounts, normally 2000), journal_entry_id (nullable until posted), status (draft/matched/exception/approved/posted/paid/void), received_at.
- **`vendor_bill_lines`**: id, vendor_bill_id, po_line_id (nullable), description, qty_invoiced, unit_price, tax_code_id, gl_account_id (for non-PO lines).
- **`payments`**: id, method (ach/wire/check/virtual_card — stubbed), payment_date, bank_account_id, total_amount, journal_entry_id, positive_pay_reference (nullable).
- **`payment_applications`**: id, payment_id, vendor_bill_id, applied_amount — the join table that supports partial/split payments in both directions.

### 5.3 The ledger (append-only, event-sourced)
- **`journal_entries`**: entry_id, entry_number, entry_date, period_id, memo, source_type (vendor_bill/payment/manual/reversal), source_id, status (draft/posted/reversed/voided), posted_by, posted_at, reversal_of_entry_id (nullable, self-referential), currency, exchange_rate, created_at. **Insert-only once status='posted' — no UPDATE, no DELETE, enforced at the DB layer.**
- **`journal_entry_lines`**: line_id, entry_id, line_number, account_id, debit_amount, credit_amount (two non-negative columns, not a signed amount — matches the T-account mental model and makes `SUM(debit)=SUM(credit)` a literal query), currency_amount, base_currency_amount, department/class/location (optional dimensions), vendor_id (nullable, carried on AP-touching lines for subledger tie-out).

**The two AP journal entries, always separate, never one mutable status flag:**
- Entry 1 (bill approval): Dr 6xxx Expense — Cr 2000 Accounts Payable.
- Entry 2 (payment): Dr 2000 Accounts Payable — Cr 1000 Cash.
- A goods receipt posts its own accrual entry: Dr Inventory/Expense — Cr 2050 GR/IR Clearing, cleared when the invoice posts (Dr 2050 GR/IR — Cr 2000 AP).

**Idempotency**: every posting action carries a deterministic `idempotency_key` (hash of source_type+source_id+action), unique-indexed — an autonomous agent retry is far more likely than a human double-click, so this isn't optional.

### 5.4 The accountability layer (decision ledger + agent memory — carried over from the contestability design, now bound to the concrete schema)
- **`decisions`**: id, invoice_id (FK vendor_bills), node_id (extract/investigate/policy/audit), parent_decision_id, agent_id + model + model_version, started_at, ended_at, inputs_consumed (json: [{source, retrieved_at, content_hash, relied_on_span}]), tool_calls (json: [{name, args, raw_result, result_hash}]), claims (json: [{text, tag: grounded|ungrounded|contradicted, evidence_pointer}]), policy_evaluation (json: [{rule_id, threshold, actual_value, verdict}]), confidence, action_taken, reason_code (FK to `reason_codes`, never free text), forwarded_to, what_was_forwarded, prev_hash, hash. **Append-only.**
- **`reason_codes`**: a small seed table (R00_CLEAN_MATCH, R01_QUANTITY_VARIANCE, R02_PRICE_VARIANCE, R03_MISSING_PO, R04_DUPLICATE_SUSPECTED, R05_VENDOR_BANK_CHANGE, … one per exception type in §6) with a human-readable description. Agents and humans reference codes from here, never invent inline strings — this is what makes ECOA-style "specific reasons" real rather than aspirational.
- **`reviews`**: id, invoice_id, reviewer_name (from the fixed demo list), action (approve/reject/request_info/contest), reason_code, note (optional free text), created_at — itself a new, linked `decisions`-chain entry, not a side table conceptually.

### 5.5 Why event-sourced, not mutable-state (the load-bearing design call)
Real double-entry bookkeeping *is* event sourcing — a journal entry is an immutable, timestamped event, and an account balance is a projection over those events, never itself the source of truth. This is why `journal_entries`/`journal_entry_lines` are insert-only once posted, corrections are new reversal entries (never edits), and derived numbers (AP aging, trial balance) are materialized/cached but always regenerable from the log. The same discipline applies to the `decisions` table for exactly the reason this whole redesign exists: an agent that could silently overwrite a bill's approved amount or delete a bad posting is not auditable by construction, and a human contesting a three-week-old agent decision needs something to actually inspect.

### 5.6 FK backbone (the load-bearing relationships)
```
vendor_bills.vendor_id → vendors.id
vendor_bills.po_id → purchase_orders.id (nullable)
vendor_bills.journal_entry_id → journal_entries.id (set at approval)
vendor_bill_lines.po_line_id → purchase_order_lines.id (nullable, for matching)
payments.journal_entry_id → journal_entries.id (set at disbursement)
payment_applications.{payment_id, vendor_bill_id} → payments.id, vendor_bills.id
journal_entries.source_type/source_id → polymorphic pointer to the causing subledger doc
journal_entries.reversal_of_entry_id → journal_entries.id (self-referential, "reverse, never delete")
journal_entry_lines.account_id → chart_of_accounts.id
journal_entry_lines.vendor_id → vendors.id (nullable, subledger tie-out)
decisions.invoice_id → vendor_bills.id
decisions.parent_decision_id → decisions.id (self-referential, the handoff chain)
reviews.invoice_id → vendor_bills.id
vendor_corrections.vendor_id → vendors.id
```

---

## 6. Exception taxonomy — the definitive v1 list, and what's deliberately deferred

Research surfaced 30+ real, named AP exception types. Building all of them would dilute the demo and blow the time budget on long-tail cases a judge won't recognize as impressive anyway. **v1 build list (14, chosen for taxonomy breadth × demo legibility × real fraud/compliance weight):**

1. Missing or invalid PO reference.
2. Invoice received before goods receipt posted.
3. Price variance beyond tolerance.
4. Quantity variance beyond tolerance.
5. Partial shipment / multi-receipt matching.
6. Duplicate invoice (exact + embedding-similarity near-duplicate).
7. Non-PO invoice (different approval path).
8. Credit memo netting.
9. Partial/short payment.
10. Currency or tax mismatch.
11. Non-standard invoice layout / low-confidence extraction (subject to the learning-loop override).
12. Vendor master-data fraud flag (bank account changed recently) — **routed to the separate gated vendor-change workflow, never the ordinary invoice screen**, per the real-world pattern research found (a mandatory outbound callback + two-person sign-off, deliberately not bundled with routine invoice approval).
13. Blanket/standing PO consumption exceeding the remaining ceiling (new — from the extended research; concretely demonstrates we understand PO cardinality beyond one-PO-one-invoice).
14. Unit-of-measure mismatch (PO in cases, invoice in eaches — new, cheap to implement, a real and commonly-cited gap).

**Explicitly deferred, and named as such in the README (this is a feature, not an omission — it shows deliberate scope discipline):** early-payment-discount timing, retention/holdback, drop-ship/three-party POs, consignment inventory, prepayment netting, FX rate-date mismatches beyond a single realized-gain entry, 1099/withholding edge cases, multi-entity routing errors, sanctions/OFAC screening, e-invoicing regional mandates (PEPPOL/CFDI), statement-vs-invoice reconciliation. Each of these is real (see the research) and worth a "roadmap" mention, but out of scope for a 30-hour build.

**Design principle from the research, applied directly:** these 14 are two structurally different categories, and the UI must not conflate them — **document-mechanical exceptions** (1–5, 9, 10, 13, 14) are things a matching engine triages algorithmically with tolerance bands; **judgment/control exceptions** (6, 7, 8, 11, 12) must always route to a named human with authority and a mandatory reason code, never auto-clear regardless of confidence.

---

## 7. Agent architecture & tiered policy (carried over, tied to the schema)

The investigation step is a genuine tool-calling agent (OpenAI `gpt-5-nano` function-calling), not an if/else script, with tools: `get_po`, `get_receipts`, `get_vendor_history`, `check_duplicate`, `recall_vendor_corrections`, `remember_correction`, `get_policy` — each scoped per Anthropic's tool-design guidance (clear naming, consolidated multi-step operations, actionable errors, small high-impact tool count). TensorMux (`glm-4-7-flash`) runs as an independent second-opinion verifier on tier-2-eligible decisions; disagreement between the two models forces escalation rather than trusting either alone.

**Tiered policy** (visible, editable, backed by `get_policy()`, never hidden if/else):
- **Tier 0 auto-approve**: no exceptions fired, confidence ≥0.9 from both models, amount < $2,500, vendor trust_tier = trusted.
- **Tier 1 single-reviewer**: amount $2,500–$25,000, OR new vendor, OR confidence 0.6–0.9, OR one minor exception.
- **Tier 2 escalated**: amount > $25,000, OR duplicate/fraud-flag fired, OR model disagreement — requires documented rationale, cannot be single-approved.
- SLA: unresolved after a short demo-scaled window gets flagged overdue.

---

## 8. Accountability layer: Decision Ledger + Constrained Narrator (recap, now schema-bound)

Every node writes its `decisions` row at the moment it acts. The "ask it why" popover on every swimlane node and audit-viewer row runs a two-stage query: Stage A (fuzzy embedding search over `decisions` to find candidate IDs) → Stage B (fetch the exact records for those IDs plus linked parents/children, and answer using *only* that closed set, every claim carrying a citation, contrastive framing by default — "held rather than auto-approved, because X; would have cleared if Y" — and an explicit "not recorded" fallback rather than invented inference). Contesting a decision writes a new linked `decisions` row and can trigger a bounded re-investigation.

---

## 9. Screen-by-screen UI spec ("every pixel")

**Design system baseline** (grounded directly in the observed Tipalti/Stampli/Ramp/FloQast/Vic.ai/BlackLine patterns, not invented): white/near-white background, near-black text, ONE brand accent color used only on the primary CTA and active states; status color is never decorative — green=clean/matched/approved, yellow/orange=needs review (not crisis), red=blocked/fraud/off-track, blue=in-progress/neutral — every color paired with an icon + text label, never color alone; when child statuses roll up to a parent badge, escalate to the worst color present; all numeric/currency columns right-aligned with tabular figures, all text columns left-aligned, never mixed in one column; "quiet chrome" — shrink borders/shadows, carry hierarchy via font-weight and spacing, no decorative gradients/illustration.

**Screen A — Dashboard (landing).** Leads with a backlog/liability metric, not a vanity chart — "7 invoices need you right now" as the single dominant number (matches Bill.com/BlackLine/FloQast convention: lead with what needs a human, not cumulative success). Below it, in Maximor's own vocabulary: straight-through-processing rate, escalation rate, override/correction rate over time, exception-type breakdown, a visible "N vendor-specific corrections learned" counter (the learning loop, made visible), and a small "chain verified ✓" integrity indicator for the whole ledger. Nav is task-verb-scoped (Ramp's pattern): "Review invoices / Approve payments / Audit trail / Policy" — not data-noun-scoped ("Ledger," "Entities").

**Screen B — Invoice queue.** Dense list (Vic.ai/Bill.com/Ramp convention — reads credible/enterprise, not toy): columns vendor, amount (right-aligned, tabular), due date, a single status badge (using the 4-state Vic.ai-style vocabulary: no badge=clean/auto-cleared / yellow-or-red confidence label naming the specific uncertain field / a distinct "Autopilot ✓" icon for fully touchless items — not a flat 3-color badge), and a compact inline action. A row expands in place into the detail view (Stampli's approach) rather than routing to a separate page.

**Screen C — Invoice detail / drill-down (the centerpiece screen).** Stampli's core conceit, directly reused: the source document is the visual anchor, with extracted structured fields overlaid on/adjacent to the regions of the document they came from — not a disconnected form. Below/beside it, a 3-column PO / Goods-Receipt / Invoice comparison grid showing only the delta fields highlighted (not three full documents at equal weight), with the tolerance threshold shown inline next to any auto-cleared match. To the side, a vertical, reverse-chronological activity feed mixing human comments and agent/system actions in one timeline (Stampli's audit-trail-as-comment-thread pattern) — this IS our swimlane, styled as a legible conversation rather than a progress spinner: "Extractor agent: parsed invoice, 94% confidence · Investigator agent: queried PO #4521, found qty variance (900 received vs 1,000 ordered) · Policy engine: escalated to Tier 1 (quantity variance) · [click any line for the three-tier drill-down: reason code → contrastive explanation → full raw decision record]."

**Screen D — Reviewer action.** Approve / Reject / Contest, each requiring a reason code from the fixed enum (optional free text alongside) — framed as confirm-a-specific-claim, not investigate-from-scratch, per the "diff/claim-confirmation" design principle.

**Screen E — Audit trail / decision-ledger viewer.** Per-invoice full timeline (decision, review, contest, state-transition), the hash-chain "sealed ✓" indicator, and the same click-to-interrogate popover as Screen C. A secondary "period health" panel gives the honest R2R stand-in: GR/IR clearing balance, AP-subledger-to-GL tie-out status, both computed live from the real ledger.

**Screen F — Policy matrix.** The tiered policy table (§7) rendered as a visible, human-readable, editable settings page — never hidden logic.

**Screen G — "Where this fits" ecosystem map.** A simple diagram: Procure-to-Pay (lit up, functional) → Record-to-Report / Treasury / Audit (greyed out, labeled "next"), with the three real handoff points from §2 called out with one line each. Cheap to build, directly answers "how well grounded is this in the real Office of the CFO" without having to build four more workflows.

**Screen H — Vendor memory view.** For a given vendor: its trust tier, its correction history (`vendor_corrections`), and a visible before/after moment — "first invoice from Acme Co. with this PO format: escalated. After one correction: auto-recognized." This is the single most concrete, demoable proof of the learning loop.

---

## 10. User flows / use cases (the demo script's backbone)

- **UC1 — Happy path**: clean invoice, 3-way match within tolerance, both models agree ≥0.9 confidence, auto-approved, posted, shown ticking up the dashboard's straight-through rate.
- **UC2 — Price variance escalation**: invoice priced 4% over PO; investigator agent gathers evidence, policy engine routes to Tier 1; reviewer sees the delta-highlighted comparison, approves with a reason code.
- **UC3 — Duplicate/fraud catch (the video's hero moment)**: a near-duplicate invoice (same vendor/amount, different invoice number) is caught via embedding similarity, escalated Tier 2, shown side-by-side with the original, confirmed as duplicate and blocked.
- **UC4 — Vendor bank-change fraud flag**: routed to the separate gated workflow, old-vs-new bank details shown, mandatory two-person sign-off simulated via the fixed reviewer list.
- **UC5 — Non-PO invoice**: routed to GL-coding path instead of 3-way match.
- **UC6 — Learning loop**: a vendor's non-standard layout triggers exception #11 the first time; a human correction is recorded via `remember_correction`; the next invoice from that same vendor recalls the correction and clears without re-flagging — shown explicitly on Screen H.
- **UC7 — "Ask why" interrogation**: click any past decision, ask a contrastive question, get an answer citing the exact record, or "not recorded" if it's genuinely outside what was captured.
- **UC8 — Contest**: a reviewer disagrees with an auto-approval after the fact, contests it, and a new linked decision record documents the outcome.
- **UC9 — Ecosystem preview**: Screen G, narrated once in the demo video as "this is where Open Ledger sits, and here's exactly how it would hand off to close and audit."

---

## 11. Explicitly out of scope (documented deferrals — see §6 for the exception-taxonomy cut list; also: real OCR/IMAP ingestion, real payment execution beyond a stub, full month-end close, O2C, live ERP integration, auth/login of any kind).

---

## 12. Team split (2 people — pending confirmation of names/skills)

Proposed division once confirmed: one person owns the ledger/schema/agent-pipeline backend (§5, §7, §8), the other owns the UI (§9) and the demo dataset/eval harness/video. Both review each other's PRs through AO. To be finalized with the team before assigning real AO sessions.

## 13. Open questions / Opus-audit checklist

- Does the 14-exception v1 cut (§6) strike the right breadth-vs-buildability balance, or should any deferred item be pulled in / any v1 item be cut?
- Is the event-sourced ledger design (§5.5) worth its complexity for a 30-hour build, or should posted-entry immutability be relaxed for time (with the tradeoff stated honestly)?
- Is Screen G (ecosystem map) worth the build time relative to hardening the core 14 exceptions further?
- Any gap between this document and what SPEC.md's build-process instructions should say once we resume building?
