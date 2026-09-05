# Open Ledger — Closed Gaps: Algorithms, Prompts, and Bounds

Everything BUILD.md named but didn't write out. After this file, nothing in the spec set is "figure it out later" — it's either here, or it's a real implementation task with no remaining ambiguity about *what* to implement.

---

## 1. Line matching — the actual algorithm (`lib/matching/line-match.ts`)

**Primary pass (greedy + fuzzy fallback, spec §1.4.1):**
```
function matchLinesGreedy(invoiceLines, poLines):
  unmatched = copy(poLines)
  results = []
  for invLine in invoiceLines:
    match = unmatched.find(p => p.lineNumber == invLine.poLineNumber)      // primary key
    if not match:
      candidates = unmatched.filter(p =>
        descriptionSimilarity(p.description, invLine.description) >= 0.85
        and p.uom == invLine.uom)                                         // fallback key
      match = candidates[0]  // if >1 candidate, pick highest similarity
    if match:
      remove match from unmatched
      qtyVariance = abs(invLine.qty - match.qtyOrdered) / match.qtyOrdered
      priceVariance = abs(invLine.unitPrice - match.unitPrice) / match.unitPrice
      amountVariance = abs(invLine.lineAmount - match.unitPrice * invLine.qty)
      results.push({invLine, poLine: match, qtyVariance, priceVariance, amountVariance,
                     zone: classifyToleranceZone(qtyVariance, priceVariance, amountVariance)})  // spec §1.5 table
    else:
      results.push({invLine, poLine: null, unmatched: true})
  return {results, stillUnmatchedPoLines: unmatched, stillUnmatchedInvoiceLines: results.filter(r => r.poLine == null)}
```
`descriptionSimilarity` = a simple token-overlap or trigram Jaccard score is sufficient at hackathon scale — don't reach for an embedding call here, this is cheap string comparison, not semantic judgment.

**Many-to-many pass (spec §1.7, only runs on what's still unmatched after the greedy pass):**
```
function matchLinesHungarian(remainingInvoiceLines, remainingPoLines):
  n = max(len(remainingInvoiceLines), len(remainingPoLines))
  cost[i][j] = abs(invoiceLines[i].lineAmount - poLines[j].lineAmount)
               if matchable (uom-compatible or convertible) else INFINITY
  pad cost matrix to n×n with 0-cost dummy rows/cols for the size mismatch
  assignment = kuhnMunkres(cost)     // standard O(n³) algorithm — USE A LIBRARY, do not hand-roll:
                                      // npm `munkres-js` or equivalent. This is a 70-year-old solved
                                      // algorithm; hand-rolling it is where bugs live, not value.
  for (i, j) in assignment where cost[i][j] < INFINITY:
    apply the same tolerance-zone classification as the greedy pass
  anything left unassigned → EXC-NO_PO (invoice side) or over-invoice handling (spec §1.6 Scenario C)
```

## 2. Hash-chain canonicalization (`lib/ledger/hash-chain.ts`)

```
function canonicalize(record):
  // MUST be deterministic: same logical record always produces the same string, regardless
  // of key insertion order in whatever code built the object.
  return stableStringify(omit(record, ['hash']))   // use npm `fast-json-stable-stringify` — do not
                                                     // hand-roll key-sorting, that's exactly the kind
                                                     // of subtle bug that silently breaks chain
                                                     // verification months after it's written correctly once.

function computeHash(prevHash, record):
  payload = (prevHash ?? 'GENESIS') + '|' + canonicalize(record)
  return sha256(payload)   // hex digest

function verifyChain(allRecordsInInsertOrder):
  prev = null
  for record in allRecordsInInsertOrder:
    expected = computeHash(prev, record)
    if expected != record.hash: return {valid: false, brokenAt: record.id}
    prev = record.hash
  return {valid: true}
```
`/api/audit/verify` calls `verifyChain` over every `decisions` row in `created_at` order and returns the result — this is the literal function powering the "chain verified ✓" badge. It must recompute from scratch every time it's called, never cache a "yes" from a previous check.

## 3. The reconsideration cascade — the full algorithm, plus a bound I found missing

**Gap found during review:** nothing capped how many times a node could be reconsidered — an unbounded contest loop is a real robustness hole (a confused reviewer, or a bug, could hammer the same node forever). **Fix, added now:** max 3 reconsiderations per node per invoice; the 4th contest attempt on the same node is blocked with a clear message and forces escalation to a *different, senior* reviewer tier instead of another automatic re-run — a human problem at that point, not an agent one.

```
function reconsider(originalDecisionId, question, additionalContext, actor):
  original = getDecision(originalDecisionId)
  priorReconsiderations = countDecisions(where reconsiderationOfId == originalDecisionId)
  if priorReconsiderations >= 3:
    return {error: "This has been reconsidered 3 times already — escalating to a senior reviewer instead of re-running the agent again.", action: "escalate_senior"}

  // Note, corrected: we do NOT store a raw "original prompt" blob anywhere (there's no such column in
  // schema.sql, deliberately — storing prompt text would bloat the ledger and go stale the moment the
  // underlying data changes). Instead, reinvokeNode() REBUILDS the node's context fresh from current
  // DB state (the invoice, its current MatchResult, current vendor history, etc.) exactly the way the
  // original pipeline run did, then appends the human's question on top. This is more correct anyway:
  // a reconsideration should see the CURRENT state of the world, not a stale snapshot.
  newDecision = reinvokeNode(original.nodeId, original.invoiceId, {
    humanQuestion: question,
    humanAdditionalContext: additionalContext,
  })
  writeDecision({...newDecision, reconsiderationOfId: originalDecisionId, triggeredByActor: actor, triggeredByQuestion: question})

  supersededIds = []
  if newDecision.exceptionTypes != original.exceptionTypes or newDecision.actionTaken != original.actionTaken:
    // cascade: re-run the FULL precedence/decision-matrix logic (spec §4.1-4.3), not just "policy" in isolation —
    // a changed exception type can change which OTHER exceptions apply, per the spec's co-occurrence rules.
    downstreamDecisions = getDecisionsAfter(original, in same invoice)
    for d in downstreamDecisions:
      markSuperseded(d.id, by: newDecision.id)
      supersededIds.push(d.id)
    rerunFrom('verify', invoiceId, seedingWith: newDecision)   // re-enters the pipeline at the Verify stage,
                                                                 // which re-evaluates the FULL decision matrix
                                                                 // fresh, not a patched delta
  return {newDecision, cascaded: newDecision.exceptionTypes != original.exceptionTypes, supersededDecisionIds: supersededIds}
  // must populate all 3 fields — matches ReconsiderResponse in BUILD.md §3 exactly; an earlier draft of
  // this pseudocode returned only 2 of the 3 required fields.
```

## 4. Agent prompts — the exact text (`lib/agent/prompts.ts`)

**Investigator system prompt:**
> You are the Investigator agent for Open Ledger's accounts-payable pipeline. You've been given a `MatchResult` from the deterministic matching engine for invoice `{invoice_id}` — it already contains every tolerance/threshold fact; you never recompute or second-guess a percentage or dollar comparison, that arithmetic is already final. Your job is to gather the contextual evidence a rule engine can't: confirm or rule out judgment-dependent exceptions (duplicate-suspected, vendor-trust, non-standard-layout), and produce a rationale where every claim cites a specific tool result. Call `get_vendor_history` and `check_duplicate` before concluding anything about fraud or duplication. Call `recall_vendor_corrections` before finalizing any layout/format-related exception — if a matching learned correction exists, say so explicitly and do not penalize confidence for that reason. If the evidence is genuinely insufficient to reach a confident conclusion, say so and set confidence low — never guess to sound decisive. Respond only by calling `submit_investigation`.

**`submit_investigation` tool (the forced final answer — add this as a 7th tool alongside ENGINE.md §3's six):**
```jsonc
{ "type":"function", "name":"submit_investigation", "strict":true,
  "description":"Submit your final investigation conclusion. This must be your last action in this turn.",
  "parameters":{"type":"object","properties":{
    "exception_types":{"type":"array","items":{"type":"string"}},
    "confidence":{"type":"number"},
    "rationale":{"type":"string","description":"Must cite specific tool results, e.g. 'per check_duplicate, 0.97 similarity to INV-2288'"},
    "recommended_action":{"type":"string"}
  },"required":["exception_types","confidence","rationale","recommended_action"],"additionalProperties":false} }
```

**Verifier system prompt:**
> You are the independent Verifier for a Tier-2-eligible decision on invoice `{invoice_id}`. You're given the same `MatchResult` and the Investigator's evidence and conclusion — but you must reach your own independent judgment, not defer to their stated confidence. Explicitly flag disagreement if your assessment of the exception type, fraud likelihood, or recommended action differs from theirs. Respond only via `submit_verification`.

```jsonc
// submit_verification
{ "type":"function", "name":"submit_verification", "strict":true,
  "description":"Submit your independent verification verdict. This must be your last action in this turn.",
  "parameters":{"type":"object","properties":{
    "agrees":{"type":"boolean","description":"Whether you agree with the Investigator's conclusion"},
    "exception_types":{"type":"array","items":{"type":"string"}},
    "confidence":{"type":"number"},
    "notes":{"type":"string","description":"Required if agrees=false: state specifically what you assessed differently and why"}
  },"required":["agrees","exception_types","confidence","notes"],"additionalProperties":false} }
```

**Extractor system prompt (only invoked for the 1-2 unstructured PDF/email samples):**
> Extract these fields from the invoice text below: vendor name, invoice number, invoice date, PO reference (if present), line items (description, quantity, unit price), subtotal, tax, total, currency. If a field is missing or illegible, return null rather than guessing. Report overall confidence (0-1), and flag any specific field you're uncertain about. Respond only via `submit_extraction`.

```jsonc
// submit_extraction
{ "type":"function", "name":"submit_extraction", "strict":true,
  "description":"Submit the extracted invoice fields. This must be your last action in this turn.",
  "parameters":{"type":"object","properties":{
    "vendor_name":{"type":["string","null"]}, "invoice_number":{"type":["string","null"]},
    "invoice_date":{"type":["string","null"]}, "po_reference":{"type":["string","null"]},
    "line_items":{"type":"array","items":{"type":"object","properties":{
      "description":{"type":"string"},"quantity":{"type":"number"},"unit_price":{"type":"number"}
    },"required":["description","quantity","unit_price"],"additionalProperties":false}},
    "subtotal":{"type":["number","null"]}, "tax":{"type":["number","null"]},
    "total":{"type":["number","null"]}, "currency":{"type":["string","null"]},
    "confidence":{"type":"number"}, "uncertain_fields":{"type":"array","items":{"type":"string"}}
  },"required":["vendor_name","invoice_number","invoice_date","po_reference","line_items","subtotal","tax","total","currency","confidence","uncertain_fields"],"additionalProperties":false} }
```

**Tool count, for the record**: 7 evidence-gathering tools (ENGINE.md §3, including `get_policy`) + 3 structured-output submission tools (this section) = 10 total across the three agent roles. `lib/agent/tools.ts` holds all 10.

## 5. SSE route — the actual pattern (`app/api/invoices/[id]/events/route.ts`)

```typescript
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const stream = new ReadableStream({
    start(controller) {
      const listener = (event: unknown) => controller.enqueue(`data: ${JSON.stringify(event)}\n\n`);
      pipelineEvents.on(params.id, listener);
      req.signal.addEventListener('abort', () => pipelineEvents.off(params.id, listener));
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } });
}
```
This is the standard Web Streams pattern for App Router route handlers — verify it against whichever exact Next.js version ends up in `package.json` before treating it as final, since minor API surface details shift across versions and I haven't pinned a version number yet.

## 6. Vendor bank-change gated workflow — the missing mini state machine

Flagged during review as under-specified. Full states: `flagged` → `callback_pending` (system shows old vs. new bank details, requires a logged callback: phone number used, confirmed-by, date/time — all free-text fields, no integration needed for the demo) → `callback_confirmed` or `callback_failed`. If confirmed: requires a **second, different** reviewer's sign-off (maker/checker — enforce in the UI that the confirming reviewer_name cannot equal the callback-logging reviewer_name) before the vendor record's `bank_account_changed_at` is trusted and the invoice re-enters normal processing. If failed or abandoned after a timeout (demo-scaled, e.g. 15 minutes): invoice stays permanently blocked, vendor flips to `trust_tier='flagged'`.

## 7. EXC-13 and EXC-14 — full spec, matching the adopted spec file's own format (these were only ever named, not specified, until now)

### EXC-13: Blanket PO Ceiling Exceeded

| Attribute | Detail |
|---|---|
| **Code** | `EXC-BLANKET_EXCEEDED` |
| **Name** | Blanket/Standing PO Consumption Ceiling Exceeded |
| **Detection Logic** | `po.po_type == 'blanket'` AND `(cumulative_invoiced_to_date + this_invoice.amount) > po.max_value_ceiling` (or the equivalent quantity ceiling) — checked against **cumulative** consumption across every prior invoice against this PO, not just this one. |
| **Severity** | Overage ≤10% of ceiling: **Escalate L2**; >10%: **Block**. |
| **Resolution Action** | Buyer issues a PO amendment/change-order raising the ceiling, or rejects the excess portion. Never auto-approved — it represents spend beyond the negotiated agreement. |
| **Example** | Blanket PO-9001, "Office Supplies," annual ceiling $50,000. Cumulative invoiced to date: $48,500. Invoice #INV-7701 for $3,000 would bring the total to $51,500 (3% over). Escalated L2. Buyer issues a $5,000 ceiling amendment; invoice released. |

### EXC-14: Unit-of-Measure Mismatch

| Attribute | Detail |
|---|---|
| **Code** | `EXC-UOM_MISMATCH` |
| **Name** | Unit-of-Measure Mismatch Between PO and Invoice |
| **Detection Logic** | `invoice_line.uom != po_line.uom` AND no valid conversion factor is on file for this UOM pair for this vendor/item (e.g., PO in "case," invoice in "each," no case-to-each conversion registered). |
| **Severity** | A plausible conversion exists but isn't on file (system can compute a candidate): **Escalate L1**. Units are fundamentally incompatible (e.g., "hours" vs. "each"): **Block**. |
| **Resolution Action** | AP clerk or buyer confirms/enters the conversion factor; system re-runs the match with it applied. Optionally save the confirmed factor for this vendor/item to prevent recurrence — this is a natural, cheap extension of the existing `vendor_corrections` learning-loop mechanism. |
| **Example** | PO-5502 line 2: 10 cases of widgets (1 case = 24 units) at $2.00/unit. Invoice #INV-8801 bills 240 "each" at $2.00/unit. No conversion on file. Escalated L1. Clerk confirms 1 case = 24 each; 240 each = 10 cases; matches cleanly; released. |

These two extend `docs/ap-three-way-match-spec.md`'s own Decision Matrix (§3.1) and Quick Reference Appendix — add both rows there when implementing `decision-matrix.ts`, in the same shape as `EXC-01` through `EXC-12`.

## 8. Explicit, honest limitations (say these in the README, don't let a judge discover them first)

- The "explain" groundedness check (ENGINE.md §6a) is a simple citation-presence check, not a rigorous entailment/NLI verifier — sufficient to prevent obvious fabrication, not research-grade.
- Duplicate-detection similarity thresholds (0.90-0.97 used in examples) are reasonable placeholders, not empirically tuned — say so if asked.
- The Investigator's raw chain-of-thought is deliberately excluded from the evidentiary record (only `tool_calls`/`claims`/`rationale` are), per real research on why raw reasoning traces aren't legal-grade evidence — this is intentional, not a gap, but the UI must never imply a human is seeing "everything the AI thought."
