# Open Ledger — Engine & Runtime Architecture (v1)

Status: this is the missing piece between DESIGN.md (product/schema/screens) and actual code. It answers "how does the blood flow" — the request lifecycle, the deterministic-vs-agentic split, the tool-calling wiring, the live-update mechanism, and the contest/reconsideration mechanic. This is what your teammate should read to start building in Antigravity; the UI person needs only §7 (the API contract).

**Document map:** `docs/ap-three-way-match-spec.md` (adopted almost entirely from the file you provided — it's the canonical, exact matching/exception/decision-matrix logic) + `DESIGN.md` (product design, database schema, screens) + this file (runtime wiring) = the complete pre-build spec. Nothing further needs designing before code; anything not covered by these three documents is either genuinely out of scope (§8) or a judgment call to make while building, not a gap.

---

## 1. The one architectural decision that resolves "is the LLM doing the math"

**Two layers, strictly separated:**

- **Layer 1 — the Matching & Policy Engine, pure deterministic code, zero LLM calls.** It implements `docs/ap-three-way-match-spec.md` *exactly*: pre-match validation, header/line matching (greedy assignment → fuzzy fallback → Hungarian algorithm for many-to-many), every tolerance zone, the full Decision Matrix, the dollar-threshold override table, the precedence/cascade rules, rounding/tie-breaking rules. This is a testable module — literally unit-test it against the spec's own worked examples (§4.1's three-simultaneous-exceptions case, §1.6's partial-shipment scenarios) before it ever touches a real invoice. **An LLM never computes whether 4% exceeds a 2% tolerance.** That's arithmetic; code does arithmetic correctly every time, an LLM does it correctly most of the time — and "most of the time" is not an acceptable failure mode for money.
- **Layer 2 — the Investigative Agent, an LLM with tool-calling.** It receives Layer 1's structured output (which exceptions fired, on which fields, by how much) and does the things deterministic code genuinely can't: decide whether a near-duplicate is *actually* fraud or a legitimate resubmission by reasoning over gathered context, apply a vendor-specific learned correction, synthesize a human-readable, evidence-cited rationale, and make the final call only on the genuinely fuzzy residue (e.g., is a description-similarity fuzzy match legitimate). It never re-derives a tolerance threshold — that's already a fact handed to it by Layer 1.

This split is the single most important thing to get right and to say out loud in the demo/README: it's the difference between "we wrapped an LLM around some invoices" and "we built a reliable engine and used an LLM exactly where judgment, not arithmetic, is required."

---

## 2. End-to-end data flow — the pipeline, stage by stage

Entry point: `POST /api/invoices` inserts a `vendor_bills` row (status=`processing`) and returns immediately (see §5 for why this is async). The pipeline then runs these stages in order, each one writing exactly one `decisions` row (per DESIGN.md §5.4) before handing off to the next:

1. **Extract** — for the ~28 structured/JSON demo fixtures, this is a pure parse into `vendor_bill_lines` (no LLM). For the 1-2 realistic PDF/email samples, a single LLM call extracts fields and reports its own confidence — if confidence is below threshold, this alone raises `EXC-LAYOUT` per the spec, cascading per §4.3 (stop, don't attempt matching).
2. **Pre-Match Validation** — Layer 1, deterministic, per spec §1.2: OCR/readability, exact-duplicate check, vendor-active status, currency-supported check, invoice-date sanity, mandatory-fields. If a cascade-stop exception fires (`EXC-LAYOUT`, `EXC-DUPLICATE`, `EXC-FRAUD_BANK`, `EXC-NO_PO` — spec §4.3), the pipeline halts *here* and jumps straight to Policy/Route — it never runs the matching engine on data it can't trust.
3. **Match** — Layer 1, deterministic, per spec §1.3–§1.7: header-level checks, line-level greedy/fuzzy/Hungarian matching, every tolerance zone, partial/split/over-invoice handling. Produces a structured `MatchResult` (every exception detected, matched vs. open quantities, computed variances). **No LLM call in this stage.**
4. **Investigate** — Layer 2. Receives the `MatchResult`. For exceptions that need gathered context (duplicate-suspected beyond exact match, vendor-trust judgment, a non-standard-layout override via a learned correction), it calls tools (§3) in a genuine multi-turn loop, then writes a rationale + confidence + evidence citations. For exceptions the deterministic engine already resolved unambiguously (e.g., a clean quantity match), this stage is a fast pass-through with no tool calls at all — don't force LLM involvement where the spec already produced a certain answer.
5. **Verify** — the TensorMux second-opinion pass, invoked *only* for Tier-2-eligible decisions (spec §3.2/§3.3's Escalate L2 / Block+Flag rows). Disagreement between the two models forces escalation rather than trusting either.
6. **Policy** — Layer 1, deterministic: the Decision Matrix + dollar-threshold table + precedence rules (spec §3, §4.2) applied in code against the combined Match+Investigate+Verify output, producing the final action and the exact `rule_id` that authorized it.
7. **Post/Route** — auto-approve writes the two-entry journal-entry pair (DESIGN.md §5.3) and updates status; escalate/block creates a `reviews` queue entry. This stage computes and writes the hash-chained `decisions.hash`, closing the loop for that invoice's current pass.
8. Every stage's row-insert publishes an SSE event (§4) so the swimlane UI updates live, in real time, as it actually happens — not a canned animation.

---

## 3. Tool contracts — Layer 2's actual function definitions

Current OpenAI Responses API tool-calling shape (verified against the live docs, not assumed): each tool is declared as `{type:"function", name, description, parameters:{type:"object", properties, required, additionalProperties:false}, strict:true}`; the model's response contains `output` entries of `type:"function_call"` with a `call_id`, `name`, and JSON-encoded `arguments`; you submit results back as `{type:"function_call_output", call_id, output}`. GPT-5-class models support parallel tool calls in a single turn (disable via `parallel_tool_calls:false` if ever needed).

```jsonc
// get_po
{ "type":"function", "name":"get_po", "strict":true,
  "description":"Look up a purchase order by its number, including all line items, quantities, unit prices, and current status. Use this to compare against what an invoice claims. Returns an actionable message (not null) if the PO doesn't exist.",
  "parameters":{"type":"object","properties":{"po_number":{"type":"string"}},"required":["po_number"],"additionalProperties":false} }

// get_receipts
{ "type":"function", "name":"get_receipts", "strict":true,
  "description":"Return all goods-receipt records against a PO, including partial/multiple receipts, quantities accepted/rejected, and receipt dates.",
  "parameters":{"type":"object","properties":{"po_number":{"type":"string"}},"required":["po_number"],"additionalProperties":false} }

// get_vendor_history
{ "type":"function", "name":"get_vendor_history", "strict":true,
  "description":"Return a vendor's trust tier, whether its bank details changed recently and when, and its recent invoice/correction history. Use this before judging whether an anomaly is suspicious or normal for this vendor.",
  "parameters":{"type":"object","properties":{"vendor_id":{"type":"string"}},"required":["vendor_id"],"additionalProperties":false} }

// check_duplicate
{ "type":"function", "name":"check_duplicate", "strict":true,
  "description":"Check an invoice for exact duplicates (same vendor+invoice_number) and near-duplicates (embedding similarity on vendor+amount+date+line items). Returns the matched invoice id(s) and similarity score if any.",
  "parameters":{"type":"object","properties":{"invoice_id":{"type":"string"}},"required":["invoice_id"],"additionalProperties":false} }

// recall_vendor_corrections
{ "type":"function", "name":"recall_vendor_corrections", "strict":true,
  "description":"Return previously-recorded human corrections/learned patterns for a vendor (e.g. 'this vendor's non-standard layout is normal, do not penalize confidence for it'). Always call this before finalizing a layout- or format-related exception.",
  "parameters":{"type":"object","properties":{"vendor_id":{"type":"string"}},"required":["vendor_id"],"additionalProperties":false} }

// remember_correction
{ "type":"function", "name":"remember_correction", "strict":true,
  "description":"Record a durable, vendor-scoped correction after a human overrides a decision, so future invoices from this vendor benefit from it. Call this only when explicitly instructed by a human review action, never speculatively.",
  "parameters":{"type":"object","properties":{"vendor_id":{"type":"string"},"pattern":{"type":"string"},"note":{"type":"string"},"source_invoice_id":{"type":"string"}},"required":["vendor_id","pattern","note","source_invoice_id"],"additionalProperties":false} }
```

**Example multi-turn investigation** (this is what "genuinely agentic, not a single LLM call" looks like in practice): Turn 1 — the model calls `check_duplicate` and `get_vendor_history` in parallel. Turn 2 — results come back: `check_duplicate` found a 0.97-similarity match. Turn 3 — the model calls `recall_vendor_corrections` because the near-duplicate's invoice number differs by only 3 digits, and it wants to know if this vendor has a history of resubmission errors before concluding fraud vs. innocent mistake. Turn 4 — nothing on file; the model finalizes: `exception=EXC-DUPLICATE`, confidence 0.95, rationale citing the specific similarity score and the absence of a mitigating correction. This whole exchange is what gets logged into that `decisions` row's `tool_calls` array — it IS the swimlane's "Investigator agent" timeline entries, verbatim.

---

## 4. Live-update mechanism: Server-Sent Events, not polling

`GET /api/invoices/:id/events` opens an SSE stream. Each pipeline stage's `decisions`-row insert publishes an event on an in-process `EventEmitter` keyed by invoice id — no external message broker needed at this scale (a few dozen invoices in a live demo). SSE is one-directional (server→client), which is all the swimlane and dashboard need, and it's a few lines in a Next.js API route — no extra library, no WebSocket handshake complexity. The dashboard's aggregate counters subscribe to a global (unkeyed) event stream the same way.

---

## 5. Why the pipeline is asynchronous, and how idempotency/concurrency are handled

LLM calls take real seconds; blocking a POST for 5-10s is tolerable for a demo but not good API design, and it also means the swimlane couldn't show live progress. So: `POST /api/invoices` returns immediately with `{id, status:"processing"}`, and the pipeline runs fire-and-forget in Node's event loop (no queue infrastructure needed at demo concurrency — tens of invoices, not thousands).

- **Idempotency**: every stage's write carries `idempotency_key = hash(vendor_bill_id + node_id + attempt)`, unique-indexed, so a retried stage (a timed-out call retried once) cannot double-write a decision or double-post a journal entry. This matters more for an autonomous agent than a human clicking a button once — assume retries happen.
- **Every external call (OpenAI, TensorMux) gets an explicit timeout** (e.g. 20s) **and a bounded retry** (one retry, only on timeout or 5xx — never on a 4xx, per your own standard of not retrying client errors). A failure that survives the retry writes a `decisions` row with `action_taken='error'`, a dedicated `R99_AGENT_ERROR` reason code, and surfaces as a visibly red "needs attention" item on the dashboard — it never silently drops the invoice into limbo. A fallback that hides a broken model API is a bug, not resilience.
- **Transactional writes**: the decision-row insert, any journal-entry postings, and the hash-chain update for a single stage are wrapped in one `better-sqlite3` transaction, so a crash mid-stage can't leave a half-posted invoice or a broken hash chain.
- **Hash-chain integrity under concurrency**: `better-sqlite3` is synchronous and single-connection by design, which naturally serializes every write — so `prev_hash` always reflects the true previous row without extra locking. This is a deliberate, correct-by-construction simplicity appropriate for a 30-hour build, not an oversight. Note for the record (don't build this now): scaling to Postgres would need a single-writer advisory lock around the hash-chain sequence, or a dedicated append-only ledger service — keep the hash-chain write in one function so that swap is contained later.

---

## 6. The "ask the predecessor" mechanic — the part you specifically asked for

Every decision node supports two distinct actions, both reachable from one "Ask" control in the UI:

**(a) Explain** — fast, grounded, no new agent invocation. This is the retrieval-then-constrained-answer flow from DESIGN.md §8: Stage A fuzzy-searches `decisions` for relevant records, Stage B answers using *only* the exact fetched records as context, every claim citing a `decision_id`, "not recorded" if something falls outside what was actually captured. Use this for "why did you do that."

**(b) Reconsider** — a genuine re-invocation of the upstream step, for when the explanation isn't enough and you actually want the agent to look again with new information — this is the literal analogue of calling your predecessor and asking them to double-check, not just explain themselves. `POST /api/invoices/:id/decisions/:decisionId/reconsider` with `{question, additional_context}`:
1. Loads the *original* node's full stored context (its original prompt, its tool-call history — everything it saw).
2. Re-invokes that *same* agent step (same node_id, e.g. `investigate`) with the human's question/context appended as new input, giving it the chance to call additional tools it didn't call the first time.
3. Writes a **new** `decisions` row at the same node, with a new field `reconsideration_of_id` pointing to the original, and `triggered_by = {actor, question}`. **The original row is never edited** — append-only applies to reconsideration exactly as it applies to postings.
4. **Cascade on change**: if the reconsidered result's `exception_types` or `action_taken` differ from the original, every downstream stage (verify → policy → audit) automatically re-runs from the new decision, writing new linked rows. The old downstream rows are marked `superseded_by_id`, not deleted — so the complete story ("first we thought X; a reviewer asked why; the agent looked again and found Y; policy changed to Z") stays permanently inspectable.

This is explicitly a *better* version of the human process it mirrors: a real colleague correcting a mistake over a phone call usually leaves no trace of the original error. This system keeps both, forever, which is exactly the "not a black box" property the whole project is built around. **UI note for whoever builds the frontend**: every node needs a small "revised after reconsideration — see original" affordance, not just a single current state.

---

## 7. API contract (the integration seam — give this section to whoever builds the UI)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/invoices` | POST | Create an invoice, trigger the pipeline, return immediately with `{id, status}` |
| `/api/invoices` | GET | Queue list, filterable by `status`, `exception_type` |
| `/api/invoices/:id` | GET | Full detail: current fields + the complete decisions chain (including superseded ones, flagged as such) |
| `/api/invoices/:id/events` | GET (SSE) | Live stream of decision-row events for this invoice |
| `/api/invoices/:id/decisions/:decisionId/explain` | POST | Grounded Q&A (§6a) — body `{question}` |
| `/api/invoices/:id/decisions/:decisionId/reconsider` | POST | Re-invoke a node (§6b) — body `{question, additional_context}` |
| `/api/invoices/:id/review` | POST | Human approve/reject/contest — body `{reviewer_name, action, reason_code, note?}` |
| `/api/policy` | GET | The visible, current tiered policy matrix |
| `/api/audit/verify` | GET | Recompute the hash chain from scratch and confirm integrity — powers the "chain verified ✓" badge |
| `/api/dashboard` | GET | Aggregate stats: straight-through rate, escalation rate, exception-type breakdown, corrections-learned count |

---

## 8. Robustness & scalability — honest, not over-engineered

**Genuinely solid at this scope:** append-only ledger with hash-chain integrity, idempotency keys on every posting action, bounded timeouts/retries with a visible (never silent) failure state, deterministic money-math strictly separated from LLM judgment, transactional multi-row writes, a two-model disagreement gate on the highest-stakes decisions.

**Deliberately not built, named rather than silently absent** (per the hosts' own "don't build more than you have to" guidance): horizontal scaling, a real job queue/broker, multi-tenant isolation, real authentication, a distributed hash-chain. If asked, the honest answer is "here's exactly what we'd change to scale this" (Postgres + advisory locks + a real queue), not a pretense that it's already handled.

---

## 9. Build checklist (hand this to Antigravity, in dependency order)

1. Schema migrations for every table in DESIGN.md §5, seeded chart of accounts, seeded `reason_codes` (mapped 1:1 to the spec file's `EXC-*` codes, plus `EXC-13`/`EXC-14` for blanket-PO-ceiling and UOM-mismatch, plus `R99_AGENT_ERROR`).
2. Layer 1: the deterministic Matching & Policy Engine as its own module, unit-tested against the spec file's own worked examples before anything else touches it.
3. Demo dataset generator (`npm run seed`) — one invoice engineered per exception type, ground-truth labels for the eval harness, plus a repeat-vendor pair for the learning-loop demo.
4. Layer 2: the tool-calling Investigative Agent, tools per §3, wired to OpenAI `gpt-5-nano`.
5. TensorMux second-opinion verifier for Tier-2-eligible decisions.
6. The pipeline orchestrator (§2) wiring stages 1-8 together, with SSE publishing (§4).
7. The `/explain` and `/reconsider` endpoints (§6).
8. The API layer (§7) — build this early enough that the UI person isn't blocked.
9. Eval harness: run the full seeded dataset through the pipeline, report straight-through/escalation/exception-type accuracy against ground truth, and specifically test that a `remember_correction` actually changes behavior on that vendor's next invoice.
10. README: what it does, how to run it (`npm install && npm run seed && npm run dev`), which track, the pipeline stages named, what improved across iterations (the eval harness's numbers), how AO was used to build it.

---

## 10. Conformance check against the hackathon rubric (consolidated, final pass)

| Rubric item | How this design satisfies it |
|---|---|
| AO Usage & Build Process (25%) | Built via real, AO-tracked sessions from the start (pending — this is a build-process discipline to execute, not a design gap) |
| Technical Execution & Reliability (25%) | Deterministic money-math separated from LLM judgment; bounded timeouts/retries with visible failure states; idempotent, transactional, hash-chained ledger; two-model disagreement gating; a real eval harness with ground-truth labels |
| Track Fit & Real-World Value (25%) | Accounting-correct double-entry schema; the spec file's precedence/cascade rules mirror real AP practice exactly; explicit P2P→R2R/Treasury/Audit handoffs modeled, not ignored |
| Demo & Usability (15%) | Live SSE-driven swimlane (not a canned animation); the reconsideration mechanic is a genuinely novel, demoable "wow" moment |
| Innovation (10%) | The closed-loop, genuinely-interrogable, contest-and-reconsider architecture — still real whitespace per the competitive research; nobody else shows this as a working interface |

**Open item, deliberately deferred per your instruction:** integrating workflow #6 (audit-evidence/PBC gathering) as a second workflow. Not started — flagged for after this engine is built and working, not before.
