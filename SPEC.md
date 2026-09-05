You are the Project Orchestrator for "Ledger Loop," our submission to the Syndicate by Maximor hackathon (Track 2: Autonomous Office of the CFO). You are running inside Agent Orchestrator (AO) itself — your own session, PRs, and activity are what gets graded under the hackathon's "AO Usage & Build Process" criterion (25% of the score), so build for real, commit often, and use `ao spawn` to create real worker sessions for parallelizable pieces rather than doing everything in this one session. This repo (project id `ledger-loop`, registered in AO) currently contains only a .gitignore and .env.example — you are making the first real commits.

## What we're building, in one sentence
An Accounts-Payable invoice-processing agent that performs 3-way match (PO ↔ goods receipt ↔ invoice), handles a comprehensive, closed set of real-world exception types, routes anything uncertain through a tiered human-review policy, and writes an immutable, hash-chained audit trail for every decision — with a UI good enough to demo live.

## Why this exact shape (context, don't re-derive it)
- Track 2 explicitly requires "handle exceptions and human review," internal finance ops only (not consumer banking/payments).
- Judging rubric: AO Usage 25%, Technical Execution & Reliability 25%, Track Fit & Real-World Value 25%, Demo & Usability 15%, Innovation 10%. Narrow-and-fully-working beats broad-and-shallow.
- The hackathon's own judges are Maximor's team; Maximor's product pitch is an "Audit-Ready Agent" that runs ~98% of transactions straight-through and escalates ~2%, with auto-generated audit trails. Mirror that vocabulary in the UI/README (straight-through-processing rate, escalation rate, audit trail) — it reads as fluent to the people scoring this, not generic AI-hackathon boilerplate.
- Competitive research found every well-funded competitor (Brex, BlackLine, Fieldguide, etc.) *claims* transparency/multi-agent/human-in-the-loop, but none publicly show the full closed loop (detect → gather evidence → propose resolution with cited evidence → tiered approval → post back to ledger) as an actual interface. That closed loop, genuinely working and visibly inspectable, is our differentiator — not a marketing claim.

## Tech stack (decided, don't relitigate)
- Next.js (App Router) + TypeScript + Tailwind, single deployable app (API routes + UI together) — minimizes setup friction for judges (`npm install && npm run dev` should be all it takes).
- SQLite via better-sqlite3 for persistence (file-based, zero external services, easy to inspect/reset for a demo).
- Runtime model providers (already in .env.example, real keys are in the gitignored .env — read via process.env, never hardcode or log them):
  - OpenAI `gpt-5-nano` (OPENAI_API_KEY) — primary LLM for extraction/classification/reasoning steps.
  - OpenAI `text-embedding-3-small` — embeddings for duplicate-invoice / near-duplicate similarity detection.
  - TensorMux (TENSORMUX_API_KEY, TENSORMUX_BASE_URL, TENSORMUX_MODEL=glm-4-7-flash, OpenAI-compatible endpoint) — used as an INDEPENDENT second-opinion verifier specifically on high-stakes decisions (fraud flags, escalation-tier decisions): call both models, and if they disagree, force escalation to a human rather than trusting either alone. This is a genuine reliability feature, not decoration — document it as such.
  - Smallest.ai (SMALLEST_API_KEY) — voice/TTS, for a STRETCH feature only (see Stretch section). Do not let it block the core path.
  - Dodo Payments key is not yet available (blank in .env) — stub the final "trigger payment" step behind an interface so it can be wired in later without refactoring; do not block on it.

## Data model (implement as SQLite tables + TS types)
- `vendors`: id, name, bank_account_last4, bank_account_changed_at (nullable), trust_tier (trusted/new/flagged), created_at.
- `purchase_orders`: id, vendor_id, line_items (json: sku/description/qty/unit_price), status, created_at.
- `goods_receipts`: id, po_id, line_items (json: sku/qty_received/received_at), created_at. A PO can have multiple partial receipts.
- `invoices`: id, vendor_id, po_id (nullable — null means non-PO invoice), invoice_number, line_items (json), currency, tax_amount, total_amount, raw_source (text — either structured JSON or raw text/PDF-extracted text), received_at, status.
- `decisions`: id, invoice_id, agent (name+model+version), step (extract/match/classify/policy/audit), input_summary, evidence (json array: what was queried/cited), exception_types (json array, empty if clean), confidence (0-1), proposed_action (auto_approve/escalate_tier1/escalate_tier2/reject), authorizing_rule (which policy rule justified this, or null if escalated), created_at.
- `reviews`: id, invoice_id, reviewer_id, action (approve/reject/request_info), reason_code (enum, not free text — but allow an optional free-text note alongside), created_at.
- `audit_log`: id, invoice_id, event_type, payload (json snapshot of the state transition), prev_hash, hash (sha256 of prev_hash + canonical JSON of this row's other fields), created_at. Append-only — never update or delete a row. Expose an endpoint/script that recomputes the chain and verifies it, and surface a "chain verified ✓" indicator in the UI — this single visual is what makes the audit trail read as real rather than a status column with a timestamp.

## Exception taxonomy — implement detection logic for ALL 12, this is the core deliverable
1. Missing or invalid PO reference on the invoice.
2. Invoice received before the goods receipt is posted for that PO.
3. Price variance: invoice unit price vs PO unit price beyond tolerance (e.g. >2%).
4. Quantity variance: invoiced qty vs received qty beyond tolerance.
5. Partial shipment: invoice must match across multiple partial receipts against one PO.
6. Duplicate invoice: same vendor + invoice number + amount already seen, OR near-duplicate via embedding similarity on line items/vendor/amount/date.
7. Non-PO invoice (utilities/subscriptions) — different approval path, no 3-way match possible, route on amount/vendor-trust alone.
8. Credit memo netting: a credit memo must net against an open or future invoice from the same vendor, not be treated as a standalone bill.
9. Partial/short payment or disputed-then-partially-settled invoice.
10. Currency or tax-calculation mismatch.
11. Non-standard invoice layout / low-confidence extraction (the LLM extraction step reports its own confidence; below a threshold, this fires regardless of what the content says).
12. Vendor master-data fraud flag: vendor's bank_account_changed_at is within e.g. 14 days of this invoice — always escalate tier 2, never auto-approve regardless of amount/confidence.

Each invoice in the demo dataset should be engineered to trip exactly one of these (or be a clean match) so every type has a legible, isolated demo moment.

## Tiered policy (implement as an explicit, visible, editable policy object/table — not hidden if/else buried in code)
- Tier 0 auto-approve: no exception types fired, confidence ≥ 0.9 from both models (OpenAI and TensorMux agree), amount < $2,500, vendor trust_tier = trusted. Auto-post to ledger, full decision+audit record still written.
- Tier 1 single-reviewer: amount $2,500–$25,000, OR vendor trust_tier = new, OR confidence 0.6–0.9, OR exactly one minor exception (variance within secondary tolerance, non-PO invoice). Goes to the reviewer queue.
- Tier 2 escalated: amount > $25,000, OR exception #6 (duplicate) or #12 (fraud flag) fired, OR the two models disagree on classification. Requires a documented rationale from the reviewer, cannot be single-approved, and the UI must show why it escalated.
- SLA: an item unresolved after a configurable window gets reassigned/flagged overdue (use a short window like 10 minutes of demo/real time so this is actually demonstrable live, and label it clearly as a demo-scaled SLA in the UI/README).

## UI requirements (must be genuinely polished — this is scored under Demo & Usability and is core to the USP, not a nice-to-have)
1. **Live multi-agent swimlane/timeline**: as an invoice processes, show which specialized step/agent is acting (extract → match → classify → policy → audit), its confidence, and why it handed off to the next step or escalated. This is the differentiator research flagged as still rare in the market — make it real and legible, not a spinner.
2. **Exception/reviewer queue as diff/claim-confirmation**: show the proposed action with before/after state and the specific evidence cited inline (which PO, which receipt, which vendor history), so approving means confirming a specific claim, not investigating from scratch. Rejection requires a reason code (structured, from an enum), optional free text.
3. **Audit trail viewer**: per-invoice timeline of every decision/review/state-transition, with the hash-chain "sealed ✓" indicator.
4. **Dashboard**: straight-through-processing rate, escalation rate, override/correction rate over time, exception-type breakdown — in Maximor's own vocabulary (see Why section).
5. **Policy matrix shown as a visible, human-readable artifact** (not hidden logic) — e.g. a settings page showing the tiers above.

## Build process expectations (this IS the graded dimension, take it seriously)
- Spawn real `ao spawn --project ledger-loop --harness claude-code --kind worker --name "<short-name>" --branch "<branch>" --prompt "<task>"` sessions for parallelizable chunks — suggested split: (a) data model + seed/synthetic-dataset generator + exception-taxonomy detection logic, (b) policy engine + audit hash-chain + decision pipeline (multi-model calls), (c) UI: swimlane + reviewer queue, (d) UI: dashboard + audit viewer + policy-matrix page, (e) eval harness (a script that runs the full seeded dataset through the pipeline and reports straight-through/escalation/exception-type accuracy vs. the known-correct labels you assigned when generating the data). Review their PRs yourself before merging (that review activity is also part of what AO tracks). Keep yourself as the integrator, not the sole coder.
- Commit early and often. Do not batch everything into one giant commit at the end.
- Never mock the core matching/exception/policy logic — implement it for real against the seeded SQLite data. It is fine and should be disclosed in the README that the invoice "documents" are synthetic fixtures (a handful can be realistic PDF/email text run through the LLM extraction step) rather than live IMAP/OCR integration — that's a reasonable, disclosed scope cut, not a fake core feature.
- Ship a one-command setup: `npm install && npm run seed && npm run dev` should be all a judge needs. No Docker required unless it turns out to genuinely simplify things.
- Write the README to explicitly state: what the project does, how to run it, which track, what agent workflow was built (name the pipeline steps), what improved across iterations (use the eval harness's before/after numbers if you do any tuning pass), and demo/live links. Also add a short section describing how AO was used to build it (sessions spawned, roles).

## Stretch goals (only after the core above is solid and demoable — do not let these eat the critical path)
- Voice: when an invoice hits exception #1 (missing PO) or #2 (invoice-before-receipt), have an agent step place an outbound call via Smallest.ai to a stubbed "vendor" phone line to ask for the missing PO/confirm receipt timing, and resolve the exception based on the (simulated) answer. This is a strong, novel demo moment if it lands — but keep it modular so the core pipeline still works if this fails or runs out of time.
- Dodo Payments: once approved (tier 0 auto or reviewer-approved), trigger a sandboxed payment via Dodo as the literal final step ("payment batched") — implement behind an interface/stub now so it's a small addition later, not a refactor.

## What to do right now
1. Confirm you can see this repo state (.gitignore, .env.example only) and the AO project id `ledger-loop`.
2. Scaffold the Next.js + TypeScript + Tailwind app, the SQLite schema/migrations, and a `npm run seed` script that generates the demo dataset (5-8 vendors, 15-20 POs with matching receipts, 25-30 invoices — one engineered per exception type plus several clean matches) with ground-truth labels for eval purposes.
3. Spawn worker sessions for the parallelizable pieces listed above once the scaffold/schema is committed, so they have a stable base to branch from.
4. Report back (via a commit + PR, and by being ready to answer over `ao send`) once the scaffold and first vertical slice (one invoice flowing through the full pipeline end-to-end, visible in a rough UI) is working — that is the milestone to check in at before going wider.
