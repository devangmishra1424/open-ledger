# Integration contract — sockets (Engine+AO provides) and plugs (UI+Wiring calls)

**Purpose of this file:** ENGINE.md §7 describes the *planned* API surface. This file describes
the *actual, shipped, tested* functions behind it, as of `master` today — so you can check,
route by route, that every socket you need to plug into actually exists, with the exact
signature it really has (not the one originally planned, where the two differ). If something
below is missing or doesn't match what you need, that's a real gap to flag back, not something
to silently work around.

Every function listed here is real: typechecked, and covered by a passing test that hit a live
database and (where noted) a live LLM API. `npx tsc --noEmit` is clean and `npm run build`
succeeds on `master` right now.

---

## 1. Environment variables your routes/scripts need available

| Variable | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | everything under `lib/`, `db/` | Supabase **pooled** connection string (port 6543, "Transaction" mode) — required for serverless hosting |
| `OPENAI_API_KEY` | `lib/agent/investigator.ts`, `extractor.ts`, `lib/explain.ts` | |
| `OPENAI_MODEL` | same as above | optional, defaults to `gpt-5-nano` |
| `TENSORMUX_API_KEY`, `TENSORMUX_BASE_URL`, `TENSORMUX_MODEL` | `lib/agent/verifier.ts` | TensorMux's Chat-Completions-compatible endpoint; `TENSORMUX_MODEL` defaults to `glm-4-7-flash` if unset but the other two are required |

`db/client.ts` throws at import time if `DATABASE_URL` is unset — any route or script that
imports anything under `lib/`/`db/` needs it present, even indirectly.

---

## 2. Per-endpoint socket map (ENGINE.md §7's table, grounded in real code)

### `POST /api/invoices` — create + trigger the pipeline

Your route: insert the `vendor_bills` row (and `vendor_bill_lines` rows too, if you already have
structured line-item data — otherwise leave lines empty and put the raw invoice text in
`vendor_bills.raw_source`, and the extract stage will call the LLM extractor for you). Then:

```ts
import { runPipeline } from "@/lib/pipeline/orchestrator";

runPipeline(vendorBillId); // fire-and-forget — do NOT await before responding
return Response.json({ id: vendorBillId, status: "processing" });
```

`runPipeline(vendorBillId: string): Promise<void>` runs all 7 stages, writes every
`decisions` row, publishes every SSE event, and updates `vendor_bills.status` at the end. It
never throws for a normal business exception (blocks/escalations are just decisions with a
different `action_taken`) — it only throws for a genuinely broken invocation (e.g. `vendorBillId`
doesn't exist). Wrap it in a `.catch()` that logs, since it's fire-and-forget and nothing else
will surface an unhandled rejection.

**Idempotency note:** every stage's `writeDecision()` call is keyed so calling `runPipeline`
twice for the same bill is safe (each stage's second run returns the already-written decision
instead of double-posting) — but calling it twice doesn't *do* anything extra either. Don't
rely on this for retries of a genuinely new business event; it's a safety net, not a queue.

### `GET /api/invoices` — queue list

Plain DB query, no Engine function needed: `SELECT * FROM vendor_bills ORDER BY received_at DESC`.

**Gotcha:** there is no `exception_type` column on `vendor_bills`. To filter/display "what
exception is this invoice in," join against its latest `policy`-node decision:

```sql
SELECT DISTINCT ON (invoice_id) invoice_id, reason_code, action_taken
FROM decisions WHERE node_id = 'policy' ORDER BY invoice_id, seq DESC
```

### `GET /api/invoices/:id` — full detail

```ts
import { getDecisionsForInvoice } from "@/lib/ledger/decisions";
const decisions = await getDecisionsForInvoice(invoiceId); // Decision[], seq-ordered, includes superseded ones (flagged via supersededById)
```
Plus a plain `SELECT * FROM vendor_bills WHERE id = ...` for the bill's own fields.

### `GET /api/invoices/:id/events` (SSE)

```ts
import { pipelineEvents, type PipelineEvent } from "@/lib/pipeline/events";

const stream = new ReadableStream({
  start(controller) {
    const listener = (event: PipelineEvent) => controller.enqueue(`data: ${JSON.stringify(event)}\n\n`);
    pipelineEvents.on(invoiceId, listener);
    req.signal.addEventListener("abort", () => pipelineEvents.off(invoiceId, listener));
  },
});
return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
```
This is the exact ALGORITHMS.md §5 pattern, verified against the real `events.ts`. A `PipelineEvent`
is `{ invoiceId, nodeId, decisionId, actionTaken?, at }`. The dashboard's aggregate view should
subscribe to `pipelineEvents.on("*", listener)` instead of one invoice id.

### `POST /api/invoices/:id/decisions/:decisionId/explain`

```ts
import { explain } from "@/lib/explain";
const result = await explain(invoiceId, decisionId, question);
// { answer: string, citedDecisionIds: string[], grounded: boolean }
```
This makes a real OpenAI call (~10-15s typical). `grounded: false` means the model didn't cite
any real decision id in its answer — worth surfacing that distinction in the UI (e.g. a "not
grounded" badge), not just showing the raw text either way.

### `POST /api/invoices/:id/decisions/:decisionId/reconsider`

```ts
import { reconsider, isEscalateSeniorResult } from "@/lib/pipeline/reconsider";

const result = await reconsider({ originalDecisionId: decisionId, question, additionalContext, actor: reviewerName });
if (isEscalateSeniorResult(result)) {
  // result: { error: string, action: "escalate_senior" } — the 3-reconsideration cap was hit
} else {
  // result: { newDecision: Decision, cascaded: boolean, supersededDecisionIds: string[] }
}
```
**Only decisions with `nodeId === 'investigate'` or `'verify'` can be reconsidered** —
`reconsider()` throws a clear error for any other node (match/validate/policy/audit are
deterministic, nothing to "ask again"). Have the UI only show the Reconsider affordance on
those two node types.

### `POST /api/invoices/:id/review`

No dedicated Engine function — this is a plain `INSERT INTO reviews (...)` (schema: `id,
invoice_id, reviewer_name, action, reason_code, note, decision_id, created_at`). If the human's
review action should also change the invoice's status or trigger a `remember_correction` call,
that's your route's own logic:
```ts
import { rememberCorrection } from "@/lib/agent/tools"; // only when a human explicitly says "remember this pattern"
```

### `GET /api/policy`

```ts
import { getPolicy } from "@/lib/agent/tools";
const policy = getPolicy(); // { dollarThresholdTable, precedenceRank } — synchronous, no DB call
```
This re-exports `decision-matrix.ts`'s own live constants — always current, never a second copy
that could drift.

### `GET /api/audit/verify`

```ts
import { getAllDecisionsInOrder, toChainableRecord } from "@/lib/ledger/decisions";
import { verifyChain } from "@/lib/ledger/hash-chain";

const all = await getAllDecisionsInOrder();
const result = verifyChain(all.map(toChainableRecord));
// { valid: boolean, checked: number, brokenAt?: string }
```
**Use `toChainableRecord`, not `hashableRow` directly** — `hashableRow()`'s own output has no
`.hash` field (it's the thing being computed, not an input), so passing it straight to
`verifyChain` makes every record fail immediately on an always-`undefined` comparison. This bit
me once already; `toChainableRecord` is the one that's actually safe to use.

### `GET /api/dashboard`

No single Engine function ships this yet — it's an aggregation query your route writes
directly, e.g. straight-through rate = `count(policy decisions where action_taken='auto_approve') / count(all policy decisions)` over whatever window you want, `exception_type` breakdown = `GROUP BY reason_code` on policy-node decisions. `chainVerified` = call the same path as `/api/audit/verify` above.

### `POST /api/invoices/:id/pay` (not in ENGINE.md's table, but journal.ts supports it)

```ts
import { postPayment } from "@/lib/ledger/journal";
const result = await postPayment(paymentId, [{ vendorBillId, appliedAmount }, ...]);
// { journalEntryId: string, alreadyPosted: boolean }
```
You'll need to insert the `payments` row yourself first (schema: `id, method, payment_date,
bank_account_id, total_amount, journal_entry_id, positive_pay_reference`), then call this with
that `paymentId` plus the bill(s) it's applied against (supports split payment across multiple
bills). Not currently called by anything in `lib/pipeline/` — the hero workflow ends at
posting the approval entry, not disbursement, so this is exposed but unwired until a payment
UI/route calls it.

### `/api/pbc/*` (workflow #6) — **not built yet, on either side**

`lib/audit/*` doesn't exist. `AUDIT.md` is a complete design (reuses `decisions` + `explain.ts`,
one new table `pbc_requests` which already exists in `db/schema.sql`, `node_id='audit_assemble'`
already reserved in the schema's own CHECK constraint) — but nobody has written the actual
`lib/audit/pbc.ts` / `evidence-assembler.ts` / `narrator.ts` yet. This is real, scoped, ready-to-build
work, not a stub to route around.

---

## 3. Things that exist but aren't wired into anything yet (know these before you build around them)

- **`lib/ledger/journal.ts`'s `postPayment`** — built, tested, callable, but nothing in the
  pipeline calls it (see `/api/invoices/:id/pay` above — it's genuinely a "bring your own route").
- **GR/IR clearing accounting** — `postBillApproval` posts a plain Dr Expense/Cr AP entry for
  every bill, PO-linked or not. The fuller Dr Inventory-Cr GR/IR-then-Dr GR/IR-Cr AP flow
  `DESIGN.md` §5.3 describes for PO-linked bills isn't implemented — there's no goods-receipt
  posting step to clear against. `vendor_bills.status` still correctly reaches `'posted'`, the
  accounting is just simpler than the fullest version of the design.
- **`EXC-FRAUD_BANK`'s gated workflow** (ALGORITHMS.md §6 — bank-change detection →
  `vendor_bank_change_reviews` → maker/checker sign-off) — the `vendor_bank_change_reviews`
  table exists, `decision-matrix.ts`'s `evaluateFraudBank()` exists, but nothing in
  `lib/pipeline/match-stage.ts` ever detects a bank-detail change and routes into it. If your UI
  needs to demo this exception, it needs its own state machine built first — flag before assuming it's live.
- **`EXC-TAX_VAR`, `EXC-CREDIT_MEMO`, `EXC-BLANKET_EXCEEDED`, `EXC-UOM_MISMATCH`** — not
  detected by `match-stage.ts` (each has a real, stated data-gap reason — see the comment at the
  top of that file). Their `decision-matrix.ts` evaluators exist and are unit-tested against the
  spec's own worked examples, so wiring one in later is additive, not a rewrite — but right now,
  an invoice that should trigger one of these won't.
- **Embeddings** — `lib/embeddings.ts` is listed as Engine+AO's file in BUILD.md but doesn't
  exist. `check_duplicate` (near-duplicate detection) and `lib/explain.ts` (Stage A relevance)
  both use a deterministic trigram-similarity heuristic instead, documented inline at both call
  sites. Real, working, tested — just not literally an embedding search.

---

## 4. Shared contract — do not redefine

`lib/types.ts` is the one file both halves import from (BUILD.md §9). If a shape you need isn't
there, add to it and say so — don't redefine an equivalent interface in `app/` or `lib/audit/`
that could quietly drift out of sync with the real one `lib/` code uses.
