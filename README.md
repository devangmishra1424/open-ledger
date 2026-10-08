# VeriBook (Open Ledger)

Accounts-payable invoice processing with a three-way match (purchase order, goods receipt, invoice). Invoices come in, are read, checked against the PO and the delivery, and either approved and posted to a double-entry ledger or put in front of a person with the reason. Every decision, including each human approval, is chained to the one before it with SHA-256, so the history is tamper-evident.

It is a working system, not a mock-up, and it is explicit about what is real and what is simulated.

## The idea in one paragraph

Deterministic code makes the money decisions; AI is used where judgment is needed and is never allowed to loosen a rule. A rules engine does the matching and applies the approval policy. An AI Investigator looks into exceptions with tools (vendor history, PO lookup), a second AI from a different model family double-checks it, and either can only make the outcome *stricter*. People decide the rest, and what they decide is recorded in the same audit chain as the machine's steps.

## What is real and what is simulated

| | Status |
|---|---|
| Reading invoices | Real. A deterministic template parser first; an LLM only for layouts it cannot read. Confidence is computed from checks (required fields, lines add up, subtotal + tax = total), not taken from the model. |
| Three-way matching, tolerances, exception taxonomy (14 codes), approval policy | Real. Deterministic; from the written spec in `docs/ap-three-way-match-spec.md`. |
| AI investigation and second-opinion review | Real, on Groq (`openai/gpt-oss-120b` and `qwen/qwen3.8-27b` by default, configurable). Subject to the provider's free-tier quotas. |
| Double-entry ledger, accounting periods | Real. Balanced journal entries in Postgres; a month's period is opened on first use; closed periods block posting. |
| Audit chain | Real. Append-only, SHA-256 chained, recomputed from the first record on demand. Tamper-evident, not a blockchain. |
| **Payments** | **Simulated.** Recorded and posted (Dr AP / Cr Cash), no money moves. Every screen says so. |
| **Vendor bank-detail callbacks** | **Manual.** A person phones the vendor and records the answer; a different person signs off. No automated call is placed. |
| **Sign-in** | **None.** Reviewer names are self-declared. "A different person" checks compare typed names. |

## Try it

```bash
npm install
cp .env.example .env            # DATABASE_URL (Supabase/Postgres), GROQ_API_KEY
# one-time: a demo database schema, separate from the live tables
DB_SCHEMA=veribook_demo npm run migrate
DB_SCHEMA=veribook_demo npm run seed       # 8 invoices through the real pipeline (uses AI quota)
npm run dev:demo                 # API on :3001, against the demo schema
npm --prefix frontend install && npm --prefix frontend run dev   # UI on :5173
```

Open the inbox. Six invoices will be waiting, each for a different reason: a bank-detail change on the vendor, a price variance, a unit-of-measure mismatch, a missing PO, a blanket-PO ceiling, a credit memo. Open the bank-detail one and walk the verification: log the call, record the vendor's answer, then switch name (sidebar) and sign off as a second person; only then can it be approved.

`npm run migrate` and the demo-wipe scripts refuse to touch the live schema without `--yes`.

## Checks

```bash
npm run typecheck
npm test                        # runs in its own schema (veribook_test); live tables are never touched
SKIP_LIVE_LLM=1 npm test        # skip the suites that call the AI provider and spend quota
npm run eval                    # extraction benchmark: deterministic, no cost  (docs/EVAL.md)
npm run bench:llm -- 6          # compare candidate models for the Investigator
```

## Where to read next

- **`docs/HOW_IT_WORKS.md`**: each feature, how it works, why it was built that way, how it fails, and what is still weak. Written to be explained from.
- **`docs/EVAL.md`**: what was measured, how, and what the numbers do not show.
- `docs/ap-three-way-match-spec.md`: the matching and exception spec the engine implements.
- `DESIGN.md`, `ENGINE.md`, `ALGORITHMS.md`, `BUILD.md`, `AUDIT*.md`, `UI_DESIGN_BRIEF.md`, `SPEC.md`: the original design documents from before the code existed. They describe intent and some of it has since changed (the AI provider, the payment rail, the UI); where they disagree with `docs/HOW_IT_WORKS.md`, the latter is right.

## Known limits

- Single tenant, no authentication, no roles. Reviewer identity is a typed name.
- Payments are a simulation, made at approval rather than scheduled by due date or early-payment terms.
- One currency in the ledger: invoices carry a currency, but there is no FX conversion and amounts are not summed across currencies.
- Money columns are `REAL` (float4) in the live database; a `NUMERIC` migration is written but needs to be applied deliberately (see `docs/HOW_IT_WORKS.md`).
- No goods-receipt accrual (GR/IR clearing); bills post Dr Expense / Cr AP.
- AI steps depend on a provider whose free tier caps tokens per minute and per day; a capped step stops the invoice for a person with the reason, and "Retry AI review" re-runs it.
