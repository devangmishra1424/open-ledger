# Open Ledger — Master Build Specification

This is the final, implementation-ready document. Read order for a newcomer: `DESIGN.md` (what/why) → `docs/ap-three-way-match-spec.md` (the exact matching logic) → `ENGINE.md` (the #3 runtime architecture) → `AUDIT.md` (the #6 extension) → **this file** (the literal repo you're about to build, file by file, wire by wire). Nothing below overrides those docs — it makes them buildable.

---

## 1. Repo structure (create exactly this)

```
open-ledger/
├── .env.example / .env (gitignored)
├── package.json, tsconfig.json, next.config.js, tailwind.config.ts
├── README.md, SPEC.md, DESIGN.md, ENGINE.md, AUDIT.md, BUILD.md
├── docs/ap-three-way-match-spec.md
├── db/
│   ├── schema.sql          # §2 below — copy verbatim as your first commit
│   ├── migrate.ts          # runs schema.sql + seeds reason_codes/chart_of_accounts against a fresh .sqlite file
│   └── client.ts           # better-sqlite3 singleton (WAL mode, foreign_keys=ON)
├── scripts/
│   ├── seed.ts             # demo dataset: vendors, POs, receipts, invoices (one per EXC-*), PBC items
│   └── eval.ts             # runs seed data through the pipeline, reports straight-through/escalation accuracy vs ground truth
├── lib/
│   ├── types.ts             # §3 below — the ONE shared contract file, copy verbatim as your second commit
│   ├── ledger/
│   │   ├── hash-chain.ts    # canonicalize(record) + sha256(prevHash + canonical) — §5.1
│   │   ├── journal.ts       # postBillApproval(), postPayment() — the two-entry pattern, idempotent
│   │   └── decisions.ts     # writeDecision(), supersede(), the append-only insert + hash chain
│   ├── matching/             # Layer 1 — deterministic, implements docs/ap-three-way-match-spec.md exactly
│   │   ├── pre-match-validation.ts   # spec §1.2
│   │   ├── header-match.ts           # spec §1.3
│   │   ├── line-match.ts             # spec §1.4, §1.7 (greedy → fuzzy → Hungarian)
│   │   ├── tolerance-zones.ts        # spec §1.5
│   │   ├── partial-handling.ts       # spec §1.6
│   │   ├── decision-matrix.ts        # spec §3 (the EXC-* → action table + $ overrides)
│   │   └── precedence.ts             # spec §4.1-4.3 (cascade/stop, co-occurring exceptions)
│   ├── agent/                 # Layer 2 — LLM tool-calling
│   │   ├── tools.ts          # the 6 tool schemas — §4 below
│   │   ├── investigator.ts   # multi-turn tool-calling loop (OpenAI Responses API)
│   │   ├── verifier.ts       # TensorMux second-opinion call
│   │   ├── extractor.ts      # LLM extraction, only for the 1-2 unstructured samples
│   │   └── prompts.ts        # system prompt templates
│   ├── pipeline/
│   │   ├── orchestrator.ts   # runs the 8 stages per invoice, in order — §5.2
│   │   ├── events.ts         # in-process EventEmitter, powers SSE
│   │   └── reconsider.ts     # the "ask predecessor" re-invocation + cascade — ENGINE.md §6b
│   ├── audit/                 # #6, self-contained (AUDIT.md)
│   │   ├── pbc.ts
│   │   ├── evidence-assembler.ts
│   │   └── narrator.ts        # thin wrapper calling the SAME explain function as lib/pipeline
│   ├── embeddings.ts          # OpenAI text-embedding-3-small + cosine similarity
│   ├── explain.ts             # the two-stage grounded Q&A (ENGINE.md §6a) — used by BOTH #3 and #6
│   ├── voice.ts                # Smallest.ai adapter — STRETCH, isolated (§6 below)
│   └── payments/dodo.ts        # Dodo Payments adapter — STRETCH, isolated (§7 below)
├── app/
│   ├── layout.tsx, page.tsx (redirect → /dashboard)
│   ├── dashboard/page.tsx
│   ├── invoices/page.tsx, invoices/[id]/page.tsx
│   ├── audit/page.tsx
│   ├── policy/page.tsx
│   ├── map/page.tsx
│   └── api/
│       ├── invoices/route.ts                                    # POST, GET
│       ├── invoices/[id]/route.ts                                # GET
│       ├── invoices/[id]/events/route.ts                         # GET (SSE)
│       ├── invoices/[id]/review/route.ts                         # POST
│       ├── invoices/[id]/decisions/[decisionId]/explain/route.ts     # POST
│       ├── invoices/[id]/decisions/[decisionId]/reconsider/route.ts  # POST
│       ├── policy/route.ts                                       # GET
│       ├── audit/verify/route.ts                                 # GET (hash-chain check)
│       ├── dashboard/route.ts                                    # GET
│       └── pbc/route.ts, pbc/[id]/route.ts, pbc/[id]/assemble/route.ts, pbc/[id]/review/route.ts
├── components/            # owned by "the friend" doing UI — scaffolds only, built against lib/types.ts
└── tests/
    ├── matching.test.ts   # unit tests against the spec file's own worked examples (§4.1, §1.6 A/B/C)
    ├── pipeline.test.ts
    └── eval.test.ts
```

---

## 2. `db/schema.sql` — copy verbatim, this is the whole database

```sql
CREATE TABLE chart_of_accounts (
  id TEXT PRIMARY KEY, account_number TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('asset','liability','equity','revenue','expense')),
  account_subtype TEXT, normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit','credit')),
  parent_account_id TEXT REFERENCES chart_of_accounts(id),
  is_control_account INTEGER NOT NULL DEFAULT 0, currency TEXT, is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE accounting_periods (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','permanently_closed'))
);
CREATE TABLE vendors (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, remit_to_address TEXT, bank_account_last4 TEXT,
  bank_account_changed_at TEXT, trust_tier TEXT NOT NULL DEFAULT 'new' CHECK (trust_tier IN ('trusted','new','flagged')),
  tax_id TEXT, w9_on_file INTEGER NOT NULL DEFAULT 0, payment_terms_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE vendor_corrections (
  id TEXT PRIMARY KEY, vendor_id TEXT NOT NULL REFERENCES vendors(id), pattern TEXT NOT NULL,
  note TEXT, source_invoice_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE tax_codes (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, rate REAL NOT NULL,
  tax_type TEXT NOT NULL CHECK (tax_type IN ('vat','gst','sales_tax','withholding')),
  direction TEXT NOT NULL CHECK (direction IN ('input','output')),
  tax_account_id TEXT REFERENCES chart_of_accounts(id), jurisdiction TEXT,
  effective_from TEXT NOT NULL, effective_to TEXT
);
CREATE TABLE exchange_rates (
  id TEXT PRIMARY KEY, from_currency TEXT NOT NULL, to_currency TEXT NOT NULL,
  rate REAL NOT NULL, rate_date TEXT NOT NULL, rate_source TEXT
);
CREATE TABLE purchase_orders (
  id TEXT PRIMARY KEY, vendor_id TEXT NOT NULL REFERENCES vendors(id), buyer_name TEXT,
  order_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','partial','closed')),
  currency TEXT NOT NULL DEFAULT 'USD', exchange_rate REAL NOT NULL DEFAULT 1.0
);
CREATE TABLE purchase_order_lines (
  id TEXT PRIMARY KEY, po_id TEXT NOT NULL REFERENCES purchase_orders(id), line_number INTEGER NOT NULL,
  description TEXT NOT NULL, uom TEXT NOT NULL DEFAULT 'each', qty_ordered REAL NOT NULL,
  unit_price REAL NOT NULL, gl_account_id TEXT REFERENCES chart_of_accounts(id),
  tolerance_pct REAL NOT NULL DEFAULT 0.02, final_delivery INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE goods_receipts (
  id TEXT PRIMARY KEY, po_id TEXT NOT NULL REFERENCES purchase_orders(id), receipt_date TEXT NOT NULL,
  receiver_name TEXT, condition TEXT NOT NULL DEFAULT 'accepted' CHECK (condition IN ('accepted','damaged','rejected')),
  final_delivery_indicator INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE goods_receipt_lines (
  id TEXT PRIMARY KEY, goods_receipt_id TEXT NOT NULL REFERENCES goods_receipts(id),
  po_line_id TEXT NOT NULL REFERENCES purchase_order_lines(id), qty_received REAL NOT NULL
);
CREATE TABLE vendor_bills (
  id TEXT PRIMARY KEY, vendor_id TEXT NOT NULL REFERENCES vendors(id), po_id TEXT REFERENCES purchase_orders(id),
  invoice_number TEXT NOT NULL, invoice_date TEXT NOT NULL, due_date TEXT,
  currency TEXT NOT NULL DEFAULT 'USD', exchange_rate REAL NOT NULL DEFAULT 1.0,
  subtotal REAL NOT NULL, tax_total REAL NOT NULL DEFAULT 0, total_amount REAL NOT NULL,
  raw_source TEXT, ap_account_id TEXT REFERENCES chart_of_accounts(id), journal_entry_id TEXT,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','matched','exception','approved','posted','paid','void')),
  received_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(vendor_id, invoice_number)
);
CREATE TABLE vendor_bill_lines (
  id TEXT PRIMARY KEY, vendor_bill_id TEXT NOT NULL REFERENCES vendor_bills(id),
  po_line_id TEXT REFERENCES purchase_order_lines(id), description TEXT NOT NULL,
  qty_invoiced REAL NOT NULL, unit_price REAL NOT NULL,
  tax_code_id TEXT REFERENCES tax_codes(id), gl_account_id TEXT REFERENCES chart_of_accounts(id)
);
CREATE TABLE payments (
  id TEXT PRIMARY KEY, method TEXT NOT NULL DEFAULT 'ach' CHECK (method IN ('ach','wire','check','virtual_card')),
  payment_date TEXT NOT NULL, bank_account_id TEXT, total_amount REAL NOT NULL,
  journal_entry_id TEXT, positive_pay_reference TEXT
);
CREATE TABLE payment_applications (
  id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payments(id),
  vendor_bill_id TEXT NOT NULL REFERENCES vendor_bills(id), applied_amount REAL NOT NULL
);
CREATE TABLE journal_entries (
  id TEXT PRIMARY KEY, entry_number TEXT UNIQUE NOT NULL, entry_date TEXT NOT NULL,
  period_id TEXT NOT NULL REFERENCES accounting_periods(id), memo TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('vendor_bill','payment','manual','reversal')), source_id TEXT,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('draft','posted','reversed','voided')),
  posted_by TEXT, posted_at TEXT, reversal_of_entry_id TEXT REFERENCES journal_entries(id),
  currency TEXT NOT NULL DEFAULT 'USD', exchange_rate REAL NOT NULL DEFAULT 1.0,
  idempotency_key TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE journal_entry_lines (
  id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES journal_entries(id), line_number INTEGER NOT NULL,
  account_id TEXT NOT NULL REFERENCES chart_of_accounts(id),
  debit_amount REAL NOT NULL DEFAULT 0, credit_amount REAL NOT NULL DEFAULT 0,
  currency_amount REAL NOT NULL, base_currency_amount REAL NOT NULL,
  department TEXT, class TEXT, location TEXT, vendor_id TEXT REFERENCES vendors(id)
);
CREATE TABLE reason_codes (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL
);
CREATE TABLE decisions (
  id TEXT PRIMARY KEY, invoice_id TEXT REFERENCES vendor_bills(id),
  node_id TEXT NOT NULL CHECK (node_id IN ('extract','validate','match','investigate','verify','policy','audit','audit_assemble')),
  parent_decision_id TEXT REFERENCES decisions(id), reconsideration_of_id TEXT REFERENCES decisions(id),
  superseded_by_id TEXT REFERENCES decisions(id), agent_id TEXT NOT NULL, model TEXT, model_version TEXT,
  started_at TEXT NOT NULL, ended_at TEXT,
  inputs_consumed TEXT, tool_calls TEXT, claims TEXT, policy_evaluation TEXT,
  confidence REAL, action_taken TEXT, reason_code TEXT REFERENCES reason_codes(code),
  forwarded_to TEXT, what_was_forwarded TEXT, triggered_by_actor TEXT, triggered_by_question TEXT,
  idempotency_key TEXT UNIQUE, prev_hash TEXT, hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE reviews (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES vendor_bills(id), reviewer_name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('approve','reject','request_info','contest')),
  reason_code TEXT REFERENCES reason_codes(code), note TEXT, decision_id TEXT REFERENCES decisions(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE pbc_requests (
  id TEXT PRIMARY KEY,
  item_type TEXT NOT NULL CHECK (item_type IN ('trial_balance','ap_aging','invoice_bundle','tie_out_check','surl_check')),
  description TEXT NOT NULL, covered_period_id TEXT REFERENCES accounting_periods(id),
  due_date TEXT, owner_name TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','assembled','submitted','accepted','exception')),
  linked_invoice_ids TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_decisions_invoice ON decisions(invoice_id);
CREATE INDEX idx_vendor_bills_vendor ON vendor_bills(vendor_id);
CREATE INDEX idx_jel_account ON journal_entry_lines(account_id);
```

---

## 3. `lib/types.ts` — the shared contract, copy verbatim, both of you import from here and nowhere else redefines these shapes

```typescript
export type NodeId = 'extract'|'validate'|'match'|'investigate'|'verify'|'policy'|'audit'|'audit_assemble';
export type BillStatus = 'processing'|'matched'|'exception'|'approved'|'posted'|'paid'|'void';
export type ReviewAction = 'approve'|'reject'|'request_info'|'contest';
export type PbcItemType = 'trial_balance'|'ap_aging'|'invoice_bundle'|'tie_out_check'|'surl_check';
export type PbcStatus = 'open'|'assembled'|'submitted'|'accepted'|'exception';

export interface Vendor {
  id: string; name: string; bankAccountLast4?: string; bankAccountChangedAt?: string;
  trustTier: 'trusted'|'new'|'flagged'; paymentTermsCode?: string;
}

export interface VendorBill {
  id: string; vendorId: string; poId?: string; invoiceNumber: string; invoiceDate: string;
  totalAmount: number; currency: string; status: BillStatus; rawSource?: string;
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
  prevHash?: string; hash: string; createdAt: string;
}

export interface ReviewInput { reviewerName: string; action: ReviewAction; reasonCode: string; note?: string; }

export interface PbcRequest {
  id: string; itemType: PbcItemType; description: string; dueDate?: string;
  ownerName?: string; status: PbcStatus; linkedInvoiceIds?: string[];
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
```

---

## 4. Agent tool schemas (`lib/agent/tools.ts`) — verified current OpenAI Responses API syntax, ready to paste

See ENGINE.md §3 for the complete 6-tool JSON with descriptions — copy that block directly into `tools.ts`. Nothing new to add here; ENGINE.md's version is final.

---

## 5. Full data-flow trace, file-by-file (this answers "what's ingested, where it's stored, what calls it, where output goes, how it's recorded, how it's questioned")

### 5.1 Workflow #3 — one invoice, start to finish

| # | Ingested / Input | File : Function | Writes to | Output | Next stage triggered by | Recorded as | Ask-why / Reconsider |
|---|---|---|---|---|---|---|---|
| 0 | Raw invoice (JSON fixture or PDF/email text) via seed script or `POST /api/invoices` | `app/api/invoices/route.ts` → `lib/pipeline/orchestrator.ts:runPipeline(billId)` | `vendor_bills` (status=processing) | bill id | orchestrator calls stage 1 | — | — |
| 1 | `vendor_bill.rawSource` | `lib/agent/extractor.ts:extractFields()` (LLM only if unstructured) | `vendor_bill_lines` | structured fields + confidence | orchestrator | `decisions` row, node=`extract` | Yes |
| 2 | structured bill + PO/vendor lookup | `lib/matching/pre-match-validation.ts:validate()` | (reads only) | pass, or a cascade-stop exception | if stop: jump to stage 6; else continue | `decisions` row, node=`validate` | Yes |
| 3 | validated bill + linked PO + receipts | `lib/matching/header-match.ts`, `line-match.ts`, `tolerance-zones.ts`, `partial-handling.ts` | (reads only) | `MatchResult` (exceptions[], variances[]) | orchestrator | `decisions` row, node=`match` | Yes |
| 4 | `MatchResult` | `lib/agent/investigator.ts:investigate()` — calls tools in `lib/agent/tools.ts` | `vendor_corrections` (if `remember_correction` fires, only on human instruction) | cited rationale + confidence + final exception call | orchestrator | `decisions` row, node=`investigate`, `tool_calls` populated | Yes — **and Reconsider lives here** |
| 5 | investigation output, only if Tier-2-eligible | `lib/agent/verifier.ts:verify()` (TensorMux) | (reads only) | agree/disagree | orchestrator | `decisions` row, node=`verify` | Yes |
| 6 | combined output | `lib/matching/decision-matrix.ts` + `precedence.ts` | — | final action + `rule_id` | orchestrator | `decisions` row, node=`policy` | Yes |
| 7 | final action | `lib/ledger/journal.ts:postBillApproval()` (auto-approve) OR creates `reviews` queue entry | `journal_entries`, `journal_entry_lines`, or `reviews` | posted GL entry or pending review | — | `decisions` row, node=`audit`, hash computed via `lib/ledger/hash-chain.ts` | Yes |
| 8 | every row-insert above | `lib/pipeline/events.ts:publish(billId, event)` | — | SSE event | UI swimlane updates live | — | — |
| 9 (human) | reviewer approves/rejects/contests | `app/api/invoices/[id]/review/route.ts` → `lib/ledger/journal.ts` or `lib/pipeline/reconsider.ts` | `reviews`, possibly new `decisions` rows | final status | if contest: back to step 4 with `reconsiderationOfId` set | linked `decisions` row | — |

### 5.2 Workflow #6 — one PBC item

Covered in full in `AUDIT.md` §5 — same table shape, four stages instead of nine, reusing `decisions`/`explain.ts` rather than duplicating them.

---

## 6. Voice AI (Smallest.ai) — stretch, isolated adapter

**Where it hooks in:** only when `EXC-NO_PO` or `EXC-BEFORE_RCV` fires in stage 4 (`lib/agent/investigator.ts`) — as one more tool the Investigator can call: `place_vendor_call(vendorId, question)`.
**File:** `lib/voice.ts`, one function: `synthesizeAndCall(script: string): Promise<{audioUrl: string; transcript: string}>`. Everything downstream only ever sees the `transcript` string — treat it exactly like any other tool result feeding back into the investigation.
**Note, deliberately:** the exact Smallest.ai request/response wire format isn't pinned here — verify it against their docs when you actually build this piece, since it's explicitly last-priority. The isolation (one function, one file) means the rest of the system never needs to know or care what's inside it.

## 7. Dodo Payments — stretch, isolated adapter

**Where it hooks in:** the very end of stage 7 (`lib/ledger/journal.ts`), only after `postBillApproval()` succeeds — the natural terminal step ("payment batched"), never earlier.
**File:** `lib/payments/dodo.ts`, one function: `triggerPayment(billId, amount, vendorBankRef): Promise<{paymentId, status}>`. Sandbox/test mode only. Same note as Voice: verify Dodo's exact API when you get here, isolated behind one function so nothing else needs to change if it's skipped entirely.

---

## 8. Agent Orchestrator integration — Kanban, sessions, and how two humans + AO coexist on one repo

- **AO's job**: track real, isolated-worktree sessions per unit of work, each becoming a PR reviewed and merged — this is what the "AO Usage & Build Process" score is judging. Recommended session split (each `ao spawn --project open-ledger --harness claude-code --name "<x>" --branch "<y>"`): `db-schema-seed`, `matching-engine`, `ledger-hashchain`, `agent-investigator`, `pipeline-orchestrator`, `api-routes`, `audit-extension`, `eval-harness`. Each lands its own PR on the AO Kanban (Working → Needs You → In Review → Ready to Merge), giving a real, inspectable session count for the demo video.
- **Your own direct work**: since you and your teammate are committing straight to the same branch, the file split in §9 below is deliberately **disjoint** — you should almost never touch the same file in the same sitting. `lib/types.ts` and `db/schema.sql` (§2, §3 above) are already fully specified — copy them in as your very first shared commit, before either of you branches into your own half, so neither of you is inventing a competing shape for the other to reconcile later. Pull before you push; if you do collide, it'll almost always be in `lib/types.ts`, and the fix is "whoever's change is additive wins, discuss the rest."

## 9. Team split (two people, same branch)

**Track A — the Engine (precision-critical, algorithmic):** `db/`, `lib/matching/`, `lib/ledger/`, `lib/pipeline/orchestrator.ts` + `events.ts`, `tests/matching.test.ts`, `tests/pipeline.test.ts`. This is a direct, careful translation of `docs/ap-three-way-match-spec.md` into code — good fit for whichever of you is more comfortable writing precise, testable logic without leaning on an AI to invent the rules (the rules are already fully specified; this track is about correct implementation, not creative design).

**Track B — the Agent, Extensions, API, and Data:** `lib/agent/`, `lib/audit/`, `lib/embeddings.ts`, `lib/explain.ts`, `lib/pipeline/reconsider.ts`, `lib/voice.ts`, `lib/payments/dodo.ts`, all of `app/api/*`, `scripts/seed.ts`, `scripts/eval.ts`. This track leans harder on AI-assisted prompt engineering and glue code — a good fit if you're moving faster with heavy AI assistance and want lots of small, independently-testable pieces.

Neither track touches `components/` (your friend's UI, built against `lib/types.ts` + the API contract in ENGINE.md §7) or the other track's folder, by design.

## 10. Production pipeline (conception → deployed demo)

1. **Scaffold** — Next.js init, `lib/types.ts` + `db/schema.sql` in, `npm run migrate` works, empty pages render.
2. **Engine first** — Track A builds the deterministic matching engine and gets `tests/matching.test.ts` passing against the spec file's own worked examples, *before* any LLM is involved. This is the foundation everything else assumes is correct.
3. **Seed + eval scaffolding** — Track B's `seed.ts` produces the demo dataset early, so Track A has real data to test against and Track B can build the agent against real invoices, not mocks.
4. **Agent + pipeline wiring** — Track B wires the Investigator, Verifier, and orchestrator; Track A's engine is a dependency, not a collaborator, at this point.
5. **API layer** — thin routes calling into `lib/`; this is what unblocks the UI person to start building for real.
6. **Explain/Reconsider + Audit extension** — layered on once the core pipeline is solid.
7. **Testing pass** — full `eval.ts` run across all 14 exception types + the learning-loop scenario; fix whatever it surfaces.
8. **Demo/deploy prep** — freeze scope, record the video per the plan from earlier in this project, do not add features in the last few hours.

## 11. Final checklist

- [ ] `lib/types.ts` and `db/schema.sql` copied in as the first shared commit
- [ ] Track A: matching engine passes unit tests against the spec file's worked examples
- [ ] Track B: seed data covers all 14 exception types + 1 learning-loop pair + 6-8 PBC items
- [ ] Full pipeline runs end-to-end on a clean invoice (Tier 0) and a duplicate (Tier 2)
- [ ] Explain and Reconsider both work and are visibly different actions in the UI
- [ ] Audit extension reuses `decisions`/`explain.ts` — no duplicated logic
- [ ] `/api/audit/verify` genuinely recomputes and confirms the hash chain
- [ ] README states track, how to run, what improved across iterations, how AO was used
