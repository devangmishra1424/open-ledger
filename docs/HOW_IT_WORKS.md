# How VeriBook works: notes to explain it from

Each section: what it does, how, why it was built that way, how it fails, what is still weak. Code locations are given so any claim can be checked. File paths are relative to the repo root.

## 0. The map

```
document / API  →  extract  →  validate  →  match  →  investigate (AI)  →  verify (AI, only on escalations)  →  policy  →  audit (post + pay)
                                                                                                                     ↑
                              every step writes ONE decision row, chained to the previous one with SHA-256         |
                              a person's approve / reject / challenge is written into the same chain  ←  human review
```

Rule of the whole design: **deterministic code decides the money; AI advises, and can only make an outcome stricter.**

## 1. Reading an invoice (`lib/agent/extractor.ts`)

- **Order of attempts.** (1) A deterministic template parser reads labelled fields, line items in two layouts, and amounts. If it finds every required field *and the arithmetic reconciles*, that is the answer; no AI call. (2) Otherwise an LLM reads the document through a single forced tool call. (3) If the LLM is unavailable, the partial template result comes back at low confidence with the reason attached.
- **Confidence is computed, not asked for.** `assessExtraction` runs checks: vendor, invoice number, date, line items, total present; lines sum to the subtotal; subtotal + tax equals the total. Score = checks passed / checks run, capped at 0.95 (template) or 0.90 (LLM). A model's own confidence can only lower it. Below 0.85 the pipeline raises EXC-LAYOUT and a person looks.
- **Why.** A model's self-reported confidence is poorly calibrated; arithmetic that has to add up is an independent, cheap signal. It also means the common case costs no AI call.
- **Where it is weak.** The vendor name is the one field arithmetic can't verify. A `Vendor:` label is trusted; otherwise it is the first non-boilerplate, non-contact header line and is reported as `uncertain_fields`. The first benchmark missed that this heuristic was wrong on 44 of 125 ordinary invoices; see `docs/EVAL.md`.
- **If asked "why not just use an LLM for everything?"** Cost, latency, rate limits, and no way to tell when it is wrong. The checks give a defensible "send to a human" signal.

## 2. Intake (`lib/bills.ts`, `app/api/invoices*`)

Validated at the edge (400 malformed, 422 when the stated total isn't lines + tax, 409 if this vendor already sent this number), written in one transaction (vendor, bill, lines together), then the pipeline runs after the response via Next's `after()` so a serverless host doesn't freeze it half-way. The invoice's own tax and total are stored: an earlier version stored the sum of the lines and dropped tax, recording a $810 invoice as a $750 liability.

## 3. Pre-match gates and the matching engine (`lib/matching/`, `lib/pipeline/match-stage.ts`)

- **Six gates before matching** (`pre-match-validation.ts`): readability (the 85% bar), duplicate, vendor status (flagged vendors blocked), currency, invoice date, mandatory fields. A failure stops the invoice deterministically; no AI is consulted.
- **Matching.** Invoice lines are matched to PO lines greedily by description similarity (trigram Jaccard ≥ 0.85); leftovers are paired one-to-one with the Hungarian algorithm (`line-match.ts`). Variances are classified with the spec's tolerance table (price ≤ 2% green, 2-5% yellow, > 5% red; quantity, line amount, grand total, tax, date gap likewise; `tolerance-zones.ts`).
- **14 exception codes** (missing PO, invoice before receipt, price/quantity variance, duplicate, non-PO, credit memo, partial, currency, tax, layout, bank-detail change, blanket ceiling, unit-of-measure). `decision-matrix.ts` turns findings into an action with a dollar-threshold table ("more restrictive wins") and a precedence order when several fire (bank-detail change outranks everything).
- **Where the rules come from.** The written spec in `docs/ap-three-way-match-spec.md`. These are a defensible policy, not a given company's real thresholds; they are one table to change.
- **Not built:** goods-receipt accrual (GR/IR clearing). Bills post Dr Expense / Cr AP.

## 4. The two AI reviewers (`lib/agent/`)

- **Investigator** looks into an exception with tools (vendor history, PO and receipt lookup, duplicate check, learned corrections) and must finish by calling `submit_investigation`. **Verifier** reviews the Investigator's conclusion, only on escalations (`escalate_l2` / `block`), on a *different model family* (default `gpt-oss-120b` vs Qwen) so the second opinion is independent. If the Verifier disagrees, policy forces at least `escalate_l2`.
- **One tool loop** (`loop.ts`): every turn must call a tool (`tool_choice: required`), arguments are parsed strictly, the loop is capped at 8 turns, requests time out at 30 s.
- **Provider reality, all handled and tested with a fake client (`tests/agent-loop.test.ts`).** Models are retired without notice (the original id returned 404 on every call; the error now names the env var to change). Free tiers cap tokens per minute and per day (backoff, then a plain-language error). The model sometimes emits an invalid tool call, or answers in prose when a call is required, and the provider answers 400; that one 4xx is re-sampled up to three times because asking again is a different outcome. Confidence arrives on different scales (0.97, 97, 100) and is normalised to 0-1 at the boundary.
- **If asked "how do you stop the AI from approving something it shouldn't?"** It never decides. Policy takes the deterministic result and `moreRestrictive`-combines the AI's opinion with it (`lib/pipeline/orchestrator.ts` `computePolicyAction`, `lib/pipeline/reconsider.ts`). A regression test (`tests/reconsider-safety.test.ts`) pins this; removing the safeguard makes it fail, because an earlier version let a contested invoice's "auto_approve" cascade straight into posting and paying it.

## 5. Policy and guardrails (`lib/pipeline/orchestrator.ts`, `lib/settings.ts`)

Policy = deterministic action, tightened by a disagreeing Verifier, then by two guardrails from Settings: a maximum auto-approval amount and a minimum Investigator confidence (default 90, because measured clean-match confidence is 0.93-0.98; a 95 default would hold a share of clean invoices). Both can only turn an auto-approval into a human review (reason code `POLICY_LIMIT`); neither can approve anything. Before this change the Settings page stored values that nothing read.

## 6. Posting and paying (`lib/ledger/journal.ts`, `lib/payments/payments.ts`)

- **Ledger.** Double-entry, balanced to the cent, idempotent (keyed on the source), serialised with a Postgres advisory lock, entry numbers taken from the highest existing number (not a count, which collides after any delete). A month's accounting period is opened on first use; a *closed* period still blocks posting; before, a single hard-coded period made every approval after 30 September fail. The invoice row is locked while posting (`FOR UPDATE`) so a concurrent reject can't slip in between the status check and the write.
- **Payment is simulated, and says so.** The earlier code called a payment host that doesn't exist in DNS, swallowed the failure with a `console.warn`, and recorded a mock payment as if money had moved. It is now an explicit simulation with a `SIMULATED-` reference, idempotent by construction (the payment id derives from the bill id, so a retry can't pay twice), and failure is separate from posting: a bill that posted but didn't pay stays "posted, payment failed" and shows up for a person.
- **Simplification to be honest about:** payment is initiated at approval, not scheduled by due date or early-payment terms; a real AP system would schedule.

## 7. The audit chain (`lib/ledger/decisions.ts`, `hash-chain.ts`)

- Every step writes one `decisions` row: who/what, inputs, claims, confidence, action, reason code. The row's hash is `SHA-256(previous hash | canonical JSON of the row)`; the whole chain is global, ordered by a sequence column, appended under an advisory lock.
- **What it proves:** after the fact, any change to or deletion of a past record breaks every later hash, and `GET /api/audit/verify` recomputes from the first record. **What it does not prove:** it is tamper-evident, not tamper-proof (someone with database write access could rewrite the whole chain consistently; anchoring the latest hash somewhere external is the next step), and it says nothing about whether a decision was *right*. It is not a blockchain, and nothing in the product says it is.
- One column is excluded from the hash on purpose: `superseded_by_id`, the single field that legitimately changes later (a reconsideration supersedes a decision). Everything else is immutable.
- The idempotency-key check is repeated *under* the chain lock; outside it, two concurrent writers with the same key could both pass the check and one would die on the unique constraint.

## 8. People are in the chain too (`lib/ledger/human-review.ts`, `lib/bill-workflow.ts`)

- **State rules in one place** (`bill-workflow.ts`, pure): which of approve / reject / challenge is allowed in which state, with the reason in words. The server enforces it and the API sends the same answer to the UI as `actions`, so a button is never offered that the server will refuse.
- **Atomic.** Approve = post to the ledger + write a `human_review` decision + a `reviews` row in one transaction; reject = status change + decision + row in one transaction. There is no moment where the ledger says "posted" but the chain has no record of who approved.
- **Races handled and tested** (`tests/human-review.test.ts`): approve vs reject on the same invoice (exactly one wins; a rejected invoice never reaches the ledger), a double-click (one decision, one entry, one payment), approving an invoice that is on hold (refused, nothing moves).
- **Challenge** records the reviewer's question in the chain first, then asks the Investigator/Verifier to reconsider with that question. A person's decision is never superseded by a machine's.

## 9. Vendor bank-detail change control (`lib/ledger/bank-change-review.ts`, `app/api/reviews/`)

The classic payment-fraud move is "our bank account changed". A recent change puts the vendor's invoices on hold. To release it: (1) a person phones the vendor on a number from their own records, not the change request, and logs the call; (2) *that person* records whether the vendor confirmed; (3) a *different* person signs off. A failed callback flags the vendor and the hold never lifts. Approving while the hold is on is refused by the server. Tested end to end through the real route handlers (`tests/bank-change-flow.test.ts`) and walked in the UI.
**Weakness:** "different person" compares typed names; there is no login. And an earlier voice module recorded "confirmed" automatically on every call; that was removed because it made the control approve itself.

## 10. The screens (`frontend/src`)

An inbox, not a dashboard: tabs for what needs a person, what is processing, what is done, what was rejected; each row says in a few words *why*. The case panel answers, in order: what it is, why it is here, what you can do (and why a button is disabled), what the system checked, who decided what. "Why?" on any step asks the explain endpoint, which answers only from the recorded decisions and reports whether it cited any. Errors are shown with their real message; there are no silent fallbacks (the old client turned every failure, including a 409 "already approved", into an empty result).

## 11. How it is tested

- A separate schema (`veribook_test`), rebuilt each run, pinned with the connection's `search_path` (verified to hold on the pooled port); the live tables are never touched. A guard refuses to run the destructive migration against the default schema without `--yes`. This matters: the old suite deleted its own rows from the live hash chain, which its own comments flagged as a corruption risk.
- Properties, not just examples: races, idempotency, "AI text can't move money" (mutation-checked), the whole chain verifying after human actions, money round-tripping to the cent.
- Live-AI suites spend real quota and are skipped when no key is set or with `SKIP_LIVE_LLM=1`.
- Eval and benchmarks: `docs/EVAL.md`.

## 12. Money is exact

Money, quantities and rates were `REAL` (4-byte float). Rehearsing the migration on the demo data showed it directly: `SUM(total_amount)` over eight invoices returned **112460**; the true total is **112,460.50**. Columns are now `NUMERIC` (exact), read by the driver as JS numbers, and a test round-trips a $16,777,217.03 invoice and balances its ledger entry to the cent. `db/migrations/003_money_numeric.sql` converts a populated database; it has been rehearsed on a copy but **not applied to the live database** (review it first; float4 converts to numeric at 6 significant digits, so an amount above roughly $100,000 stored with cents may lose them; the demo data is well below that).

## 13. What changed in the October 2026 refinement pass (so claims stay honest)

Everything above existed in some form from the hackathon build **except** the following, which were added or rebuilt on 8 October 2026: the isolated test schema and destructive-script guards; the shared tool loop, model configuration, and provider-failure handling; the hybrid extractor with computed confidence; the simulated payment rail and the manual, maker/checker bank-change flow (plus its routes); human decisions in the hash chain with the transaction and race handling; the deterministic floor on AI reconsideration; Settings guardrails actually enforced; invoice intake validation; the read model and the inbox UI; the extraction eval and benchmarks; NUMERIC money. If an interviewer asks what was built when, this is the answer; do not describe these as part of the original build.

## 14. What I would do next

1. Real authentication and roles, so "a different person" is not a typed name.
2. Schedule payments by due date and terms (and early-payment discounts) instead of paying at approval.
3. A real payment rail behind `triggerPayment`, calling the provider *before* writing anything and failing closed.
4. Apply the NUMERIC migration and add a currency-aware ledger (FX at posting).
5. Anchor the chain's latest hash outside the database.
6. A labelled corpus of real invoices to replace the synthetic eval, and a paid AI tier (or on-premise model) so quotas stop being a failure mode.
