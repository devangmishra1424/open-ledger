# Open Ledger — Audit Support Extension (#6), same depth as ENGINE.md

Status: the thin-extension design for workflow #6 (Gathering Audit Support / PBC), confirmed direction — reuses the AP ledger, no second agent pipeline, no new exception taxonomy.

---

## 1. What this is, one more time

Not vendor screening. An auditor (external CPA or internal audit) sends a PBC ("Prepared By Client") list — specific evidence requests — and our job is to track each one, pull the evidence straight from the ledger #3 already produces, prove it ties out, and mark it accepted.

## 2. New data — one table

`pbc_requests`: id, item_type (enum: `trial_balance` | `ap_aging` | `invoice_bundle` | `tie_out_check` | `surl_check`), description, covered_period_id (FK accounting_periods), due_date, owner_name, status (open/assembled/submitted/accepted/exception), linked_invoice_ids (json array, only for `invoice_bundle` items), created_at.

Nothing else new. Every item type is answered by querying tables that already exist.

## 3. New files (all under `lib/audit/`, self-contained, nobody outside this folder needs to change)

- `lib/audit/pbc.ts` — CRUD for `pbc_requests` (createRequest, listRequests, getRequest, updateStatus).
- `lib/audit/evidence-assembler.ts` — one function per `item_type`:
  - `assembleTrialBalance(periodId)` — sums `journal_entry_lines` by account for the period. Pure SQL aggregation, already-correct data.
  - `assembleApAging(periodId)` — open `vendor_bills` bucketed by days-past-due.
  - `assembleInvoiceBundle(invoiceIds[])` — for each id, pulls the invoice + its matched PO + goods receipts + its full `decisions` chain (the same record #3 already writes) — this is the "PO, receipt, approval trail" an auditor asks for, already sitting in the ledger.
  - `assembleTieOutCheck(periodId)` — compares `SUM(vendor_bills.total_amount WHERE status != 'paid')` against the GL's Accounts Payable control-account balance; returns match/variance.
  - `assembleSurlCheck(periodId)` — flags `goods_receipts` dated near period-end with no corresponding `vendor_bills` row yet (the actual "search for unrecorded liabilities" test — a join + date filter, not a new capability).
- `lib/audit/narrator.ts` — **not a new narrator**: it's the exact same explain/citation function from `lib/pipeline` (ENGINE.md §6a), called with a `pbc_request_id` scope instead of an `invoice_id` scope. One function, two callers.

## 4. Pipeline (deliberately simple — no LLM agent stage required for most items)

1. PBC item created → `pbc_requests` row, status=`open`. (Seed script creates ~6-8 realistic items for the demo; in a real deployment this would come from an auditor-facing intake form — out of scope.)
2. `POST /api/pbc/:id/assemble` → dispatches to the matching `evidence-assembler.ts` function by `item_type` → writes the result **into the same `decisions` table** #3 uses, with `node_id='audit_assemble'` and `invoice_id` left null (or set, for `invoice_bundle` items) → `pbc_requests.status='assembled'`. **This is the key design move**: reusing the `decisions` table means every PBC assembly is automatically hash-chained, automatically explainable, automatically contestable — for free, because it's the same ledger, not a parallel one.
3. Human marks it submitted/accepted (or exception) via the same `reviews`-style action already built for #3 — `pbc_requests.status` updates.
4. For `invoice_bundle` items specifically, the click-through to each invoice's own drill-down screen (Screen C, already built) works unmodified — an auditor sampling an invoice sees exactly what an AP reviewer sees.

## 5. Data flow trace (same format as ENGINE.md §2)

| Step | Ingested/Input | Function/File | Stored | Output | Recorded as | Questionable/Contestable |
|---|---|---|---|---|---|---|
| Create | item_type, period, due date | `pbc.ts:createRequest()` | `pbc_requests` row | request id | — | n/a (not a decision yet) |
| Assemble | pbc_request_id | `evidence-assembler.ts:assemble*()` | (reads existing tables, writes nothing new except the decision row) | evidence bundle (json) | `decisions` row, node_id=`audit_assemble`, hash-chained | Yes — same "ask why"/"reconsider" popover as any AP decision |
| Review | reviewer_name, action, reason_code | same `reviews` mechanism as #3 | `pbc_requests.status` | accepted/exception | linked `decisions` row | Yes — contest re-triggers `assemble` with added context |

## 6. API additions

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/pbc` | GET/POST | List / create PBC items |
| `/api/pbc/:id` | GET | Detail incl. its decisions chain |
| `/api/pbc/:id/assemble` | POST | Run the evidence assembler for this item |
| `/api/pbc/:id/review` | POST | Mark submitted/accepted/exception |

## 7. UI

One new screen, `/audit` (Screen I) — a list identical in shape to the invoice queue (item, status chip, due date, owner), row expands to show the assembled evidence bundle using the same card/typography conventions as everything else. No new design system needed.

## 8. What's reused vs. new (the whole point, stated plainly)

**Reused, unmodified:** `decisions` table + hash chain, the explain/reconsider mechanic, the `reviews` action pattern, the design system, `journal_entries`/`vendor_bills`/`goods_receipts` (read-only for this feature).
**New:** one table, four small query functions, four API routes, one screen. No new agent, no new LLM calls, no new exception taxonomy, no new pipeline orchestrator.
