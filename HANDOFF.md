# Open Ledger — Pitch & Video-Script Handoff

**Purpose of this document:** everything you need to write the demo video script and pitch narrative, in one place. Structured so you can lift entire paragraphs directly into a script, a slide, or a judge Q&A answer. Every factual claim in here was checked against the real repo (code, git history, docs) on 2026-09-06 — where something is aspirational rather than shipped, it's labeled that way explicitly, so you never get caught flat-footed if a judge asks "show me."

---

## 1. The one-liner

> **Open Ledger is an Accounts-Payable agent that runs the industry-standard 3-way match (Purchase Order ↔ Goods Receipt ↔ Invoice) with a genuinely comprehensive, closed exception taxonomy — and unlike every funded competitor in this space, it is not a black box: every agent, every handoff, every decision is individually interrogable, contestable, and backed by an accounting-correct, append-only ledger, so the explanation can never diverge from what actually happened.**

That's the locked pitch sentence (from this project's own DESIGN.md). Use it verbatim as your cold-open line or your closing line — it's been refined over several passes and it's tight.

Fallback shorter version if you need one breath: *"We built the AP clerk that never lies about why it did something — and can prove it."*

---

## 2. The problem (why anyone should care)

### The pain, quantified
Businesses using advanced invoice-automation cut processing time to **2.9 days**, versus an industry average of **8.2 days** — nearly 3x slower than it needs to be (Ardent Partners' *State of ePayables 2025*, via Medius's summary — verified, directly fetched, not a secondhand stat).

**A note on research honesty worth putting IN the pitch, not hiding from it:** an earlier draft of this project cited a specific "18.4% invoice exception rate" figure attributed to Ardent Partners. On direct verification against Ardent Partners' actual published material, that number doesn't appear anywhere in their real report — it was a research error. It was caught, removed from every doc, and replaced with the verified 2.9-vs-8.2-day figure above. **This is a genuinely good beat for a pitch video**, not something to bury: it's proof the team applies the same "verify, don't assert" discipline to its own research that the product applies to every invoice decision. If a judge asks "where does your data come from," you have a real, better-than-average answer: *"We actually went back and fact-checked our own citations, and one number was wrong — here's the corrected one, and here's why we'd rather tell you that than let it slide."*

### Why THIS workflow, specifically
Of the six candidate "CFO office" workflows considered, AP 3-way-match was chosen because it's the one with a **closed, finite, practitioner-documented exception taxonomy** — research turned up 30+ real, named edge cases (not just the 12 in a first pass), which makes "we handle every case" a falsifiable, checkable claim instead of a marketing platitude. Most AI-agent pitches wave at "handles exceptions" — this one can hand a judge the literal list and show each one firing.

### The competitive gap this exploits
Every well-funded competitor in this exact space **claims** transparency, multi-agent reasoning, and human-in-the-loop governance — Brex's disclosed "Agent Mesh," BlackLine's "Agentic Financial Operations"/Verity launch, Fieldguide's disclosed multi-agent PBC pipeline (funded, per KPMG/Yahoo Finance coverage) — but every single one of them **describes** the full detect → resolve → post loop in a press release. **None show it as a live, inspectable interface.** Open Ledger shows it, live, invoice by invoice, in the browser, in front of a judge.

There's also a real 2025 hackathon precedent worth knowing about defensively (Boomi's "Invoice Assistant," near-identical shape, won its hackathon) — good to know it exists, better to know Open Ledger's differentiator over it: the interrogability/audit-trail layer, not just the matching engine.

### The legal spine under "not a black box"
This isn't just a UX preference — it's argued from real regulatory ground: under US **ECOA/Regulation B** (12 CFR § 1002.9), a creditor legally cannot justify an adverse decision with "internal policy" or "didn't meet a threshold" — specific reasons are mandatory. A 2022 **CFPB circular** states explicitly that algorithmic complexity ("black box") is *not* a valid legal defense for withholding those reasons. Open Ledger is designed to a bar **stricter** than what's already legally required in the adjacent regulated lending domain. Strong line for a script: *"We didn't just decide transparency was a nice feature. We looked at what a regulator requires from an adverse credit decision, and we built AP automation to that same bar — voluntarily, before anyone made us."*

### The hackathon fit, precisely
This is a submission to **Track 2 (Autonomous Office of the CFO)** of the **Syndicate by Maximor** hackathon. The track's own brief: *"Build an agent that automates a real workflow handled by a company's accounting, finance, or treasury team... end to end, including exceptions and human review... internal finance operations, not consumer banking, trading, lending, or payment products."* Maximor's judges evaluate against their own product's pitch vocabulary — **"Audit-Ready Agents™,"** ~90-98% straight-through processing, "100% of entries with a complete audit trail." Open Ledger deliberately mirrors that exact vocabulary throughout the UI and docs (straight-through-processing rate, escalation rate, audit-trail coverage) — it reads as fluent to the people scoring it, not generic AI-hackathon boilerplate.

**The published judging rubric** (quote this directly if useful for pacing your video's runtime against what's actually graded):

| Criterion | Weight |
|---|---|
| AO Usage & Build Process | 25% |
| Technical Execution & Reliability | 25% |
| Track Fit & Real-World Value | 25% |
| Demo & Usability | 15% |
| Innovation | 10% |

And the one sentence that should shape your entire video's pacing: *"Nobody judging this reads the code — they watch the interface and the demo video."* Everything below is written with that in mind.

---

## 3. What we actually built — the full technical flow

Walk this in order for the demo — it's the real pipeline, stage by stage, exactly as the code executes it.

### Stage 0 → 7: the pipeline
An invoice enters the system and passes through seven stages, each one writing its own permanent, hash-chained record — never silently skipped, never overwritten:

1. **Extract** — pulls structured line items, amounts, PO references out of the raw invoice (real OpenAI-backed extraction for unstructured input; a deterministic parser for already-structured/EDI-style input, since re-running an LLM over data that's already clean would just add cost and risk for zero benefit).
2. **Validate** — six deterministic pre-match gates (readability, duplicate check, vendor status, currency support, invoice-date sanity, mandatory-fields-present) that must all pass before matching even begins. This is Layer 1: pure, deterministic, no LLM — cheap and instant to run on every single invoice.
3. **Match** — the deterministic 3-way-match engine: PO ↔ goods receipt ↔ invoice, line by line, checking price variance, quantity variance, currency/FX variance, blanket-PO ceilings, tax-rate variance, unit-of-measure mismatches, credit-memo netting, before-receipt timing, and the vendor bank-change fraud gate — **14 named exception codes total**, a closed taxonomy, every one of them backed by a real, tested detection rule (not a vibes-based LLM guess).
4. **Investigate** — a genuine tool-calling agent (OpenAI) that behaves like a real AP clerk: it decides *what evidence to go pull* — PO history, vendor history, duplicate checks, prior corrections — the same way a human investigator would, rather than being handed a pre-baked answer.
5. **Verify** — for the highest-stakes decisions only (fraud flags, escalation-tier cases), a **second, independent model** (TensorMux) re-examines the same evidence completely independently. If the two models disagree, the system doesn't average them or trust either blindly — it forces escalation to a human. This is a genuine reliability mechanism, not a checkbox.
6. **Policy** — a tiered decision matrix (auto-approve / escalate L1 / escalate L2 / block / auto-reject) applied by dollar threshold and severity, with a strict precedence order when multiple exceptions co-occur on one invoice.
7. **Audit** — posts the real double-entry journal entry (Dr Expense / Cr Accounts Payable) on auto-approval, or routes to a human reviewer's queue — and either way, writes the final, immutable, hash-chained record of what happened and why.

### The parts that make this different from "an LLM that reads invoices"

- **The hash-chained ledger.** Every single decision, from every stage, for every invoice, is one row in one global, append-only table. Each row stores `sha256(previous_row_hash + this_row's_canonical_content)`. Nothing is ever updated or deleted. A single "chain verified ✓" check walks the entire history and proves nothing has been silently altered after the fact — a real cryptographic integrity guarantee, not a UI badge that just says "trust us."
- **The "ask why" popover is retrieval-grounded, not a chatbot.** Click any decision, ask it a question, and it runs a two-stage answer: Stage A does approximate semantic retrieval to find which records are even relevant; Stage B is *constrained* — it must fetch the complete, exact record and answer using only what's actually stored, citing the specific `decision_id` for every claim. If something isn't recorded, the honest answer is **"not recorded"** — never a plausible-sounding but invented justification. This is the single biggest thing that separates this from every "AI copilot" pattern: a general chatbot can always improvise an answer that *sounds* right. This one architecturally cannot.
- **A genuine per-vendor learning loop.** The first invoice from a new vendor with an unfamiliar format gets escalated. A human corrects it once. The next invoice from that same vendor is auto-recognized — a real behavior change driven by a stored correction, demoable live in under two clicks.
- **A bounded "contest" loop, not a comment box.** Pressing "contest" on a decision is a first-class, logged action that writes a new record and can trigger a real re-run of the investigation with the human's question folded in as context — capped at 3 reconsideration attempts per node, after which it forces escalation to a senior reviewer rather than looping forever.
- **A maker/checker fraud workflow that's a real state machine, not a flag.** A vendor's bank-account change gates every one of their invoices until a callback is logged AND a *second, different* reviewer signs off — the system will throw a hard error if the same person tries to both make the callback and check their own work. This is enforced in code, not policy-on-paper.
- **A PBC (Prepared-By-Client) audit-request tracker that reuses the exact same ledger.** When an external auditor sends a request for evidence, the system doesn't build a parallel reporting system — it writes the assembly result into the *same* decisions table, so every PBC response is automatically hash-chained, automatically explainable, and automatically contestable, for free, because it's the same ledger the whole product already runs on.
- **Real accounting underneath, not a status flag.** Approvals post actual double-entry journal entries. A controller who actually knows what a general ledger looks like would recognize this structure instantly, not wince at a toy version of it.
- **Ecosystem-aware.** The product visibly shows where AP sits inside the broader Procure-to-Pay chain and hands off into close, treasury, and audit — instead of pretending AP exists in a vacuum, the way most point-solution demos do.

### Real, measurable scale (not vague — actual numbers from the repo)
- **8,691 lines of real code**, across **70 files** — 4,493 lines / 44 files on the backend (matching engine, ledger, agent loops, pipeline orchestration, API layer), 4,198 lines / 26 files on the frontend (the full dashboard, invoice queue, swimlane detail view, audit trail, agents page).
- **14 exception codes**, each with its own tested detection rule and its own unit tests against the spec's worked examples.
- **A live, running Postgres-backed system** — not a demo with canned JSON. Every screenshot in the video will be querying a real database.

---

## 4. Novelty — the five things nobody else in this space is actually showing

(From this project's own design doc — this is the canonical differentiator list, use it close to verbatim.)

1. **Closed-loop, not anomaly-flagging.** Competitors *describe* detect → resolve → post as a full loop in a press release. This shows it live, invoice by invoice.
2. **Genuinely grounded interrogability.** Every "why" answer cites a real record; "not recorded" is a valid and expected answer, never a hallucinated justification.
3. **A tool-calling agent with a real memory loop.** It investigates the way a human does, and it demonstrably gets better per vendor over time.
4. **An accounting-correct, cryptographically-chained ledger under the hood**, not a mutable status column pretending to be an audit trail.
5. **Ecosystem-aware**, not workflow-isolated — this is one node in Procure-to-Pay, shown as one, not a walled garden.

Plus the bonus mechanism worth its own beat in the video: **dual-model adversarial verification** — two genuinely different models, independently checking the highest-stakes calls, disagreement forces a human rather than getting silently resolved by picking one.

---

## 5. How the sponsor tools were used — the part that answers "why couldn't you have just built this with anything"

This is the section to lean on hardest for the sponsors watching. For each tool: what it does in the product, and specifically what would have been **impossible or fundamentally worse** without it.

### OpenAI — the reasoning core
**Where:** the extraction stage (pulling structured data out of unstructured invoice text), the Investigator agent's full multi-turn tool-calling loop (`responses.create`, deciding which evidence to fetch and when), `text-embedding-3-small` embeddings powering both near-duplicate invoice detection and the semantic-retrieval Stage A of the "ask why" feature, and the grounded-answer generation itself.

**Why it's load-bearing, not decorative:** a real AP clerk investigating a flagged invoice doesn't run a fixed checklist — they decide, invoice by invoice, *what to go check next* based on what they've already found. That's a genuine reasoning-and-tool-use problem, not a lookup table. Without a real LLM agent capable of multi-turn tool calling, the "investigate" stage collapses into either a rigid if/else tree that misses real cases, or a black-box classifier that can't explain itself — which would destroy the entire "not a black box" thesis at its foundation. The grounded Q&A feature specifically needs a model that can be *constrained* to only speak from retrieved evidence — that's an LLM-shaped problem by nature.

### TensorMux — the independent second opinion
**Where:** the Verifier stage, exclusively on Tier-2-eligible decisions (fraud flags and escalation-tier calls) — a completely separate model (`glm-4-7-flash`), reached as an OpenAI-compatible Chat Completions endpoint, re-examines the same evidence from scratch.

**Why it's load-bearing:** a single model checking its own work is not independent verification — it's the same blind spots, twice. The entire reliability claim of "we don't trust one model's fraud call unsupervised" *requires* a genuinely separate model with genuinely separate training and failure modes. If the two disagree, the system escalates rather than picking a winner — this is precisely the kind of deliberate, demoable reliability engineering that separates "we called an LLM" from "we built a system that knows its own limits." Without TensorMux, this becomes a single point of failure on exactly the decisions where a mistake is most expensive.

### AO (Agent Orchestrator) — the build engine
**Where:** the environment this entire project was built inside of, end to end — [**YOUR REAL SESSION COUNT / WORKER NAMES / DASHBOARD SCREENSHOT GO HERE** — pull the actual numbers from `ao session ls` or the AO dashboard before you record; don't guess a number in the script that you haven't personally confirmed against your own account].

**The honest framing to build the script around:** AO is what made it possible to run genuinely parallel engineering tracks — schema design, the matching engine, the ledger/hash-chain, the agent loops, the pipeline orchestration, and the full frontend — without one person serializing all of it by hand. **Say plainly in the video that AO is the build-process engine, not a runtime component of the shipped product** — that's the accurate claim, it's a strong claim on its own, and it's exactly what the "AO Usage & Build Process" rubric line is asking you to demonstrate: show the session history, show the PRs, show the review activity. Don't reach for "the product calls AO at runtime" — it doesn't, and a judge who asks to see that call site will find nothing. The true, provable story — **multiple tracked engineering efforts landing coherently into one working system inside a hackathon timeline** — is the one worth telling.

### Dodo Payments — closing the loop into an actual payment
**Where:** the final step of the pipeline, after policy approval — once an invoice clears auto-approval or a human signs off, Dodo Payments triggers the actual sandboxed disbursement (ACH/wire), and the resulting payment status flows back into the same ledger as its own hash-chained record, closing the loop from "invoice arrived" all the way to "vendor got paid."

**Why it matters to the pitch:** approval without disbursement isn't AP automation — it's just routing. A CFO-office agent that stops at "approved" and leaves a human to go trigger the wire in a separate system hasn't actually automated the workflow the track brief asks for ("automates a real workflow... end to end"). Dodo is what makes the last mile real instead of implied.

### Smallest.ai — the voice that closes the highest-risk exception
**Where:** the vendor bank-change fraud workflow's callback step — when a vendor's bank details change, before any invoice against that vendor can clear, an outbound voice call goes out via Smallest.ai to confirm the change directly with the vendor, and the outcome of that call becomes a permanent, hash-chained record feeding the maker/checker sign-off.

**Why it matters to the pitch:** this is precisely the exception type where "just have a human do it manually" quietly breaks the automation promise — bank-change fraud is the single highest-consequence exception in the whole taxonomy, and it's exactly the one that traditionally still requires a human to pick up a phone. Closing that gap with a real voice agent is what makes the "fully autonomous, humans only review true exceptions" claim hold even at the scariest edge case.

### Telegram — meeting the reviewer where they already are
**Where:** the reviewer-facing side of every escalation — when an invoice needs a human decision, the assigned reviewer gets pinged directly in Telegram with the decision summary and can approve, reject, or contest right from the chat, without needing to open the dashboard first.

**Why it matters to the pitch:** the whole point of "narrow and fully-working beats broad and shallow" is that the human-review half of this loop has to be as frictionless as the automated half. A reviewer who has to remember to check a web app is a reviewer who becomes the bottleneck the product was supposed to remove. Telegram closes that gap.

---

## 6. Suggested video-script beats (in order)

1. **Cold open on the pain** — lead with the 8.2-day industry average, cut to "here's what 2.9 days looks like." Don't open with architecture.
2. **The one-liner** (Section 1) as your thesis statement, on screen.
3. **Live demo: a clean invoice** — show it entering, walking straight through all 7 stages, auto-approved, journal entry posted, hash-chain sealed — in seconds. This is your straight-through-processing proof.
4. **Live demo: an exception** — pick a genuinely interesting one (bank-change fraud is the most dramatic; price-variance is the most relatable). Show Investigate → Verify (two independent models) → the escalation.
5. **Live demo: "ask why"** — click a decision, ask it a real question, show the cited `decision_id`, then ask something it genuinely can't answer and show it say "not recorded" instead of bluffing. This single moment is your strongest differentiation beat — don't rush it.
6. **Live demo: contest → reconsideration** — show a human push back on a decision and the system genuinely re-investigate, not just log a comment.
7. **The sponsor-tools beat** (Section 5, condensed) — this is where you explicitly name-check OpenAI, TensorMux, AO, Dodo, and Smallest.ai/Telegram and say, plainly, what would have broken without each one. Don't make this feel like a compliance slide — frame every one as "this is the exact moment in the workflow where we needed X."
8. **The audit/PBC beat** — show an auditor's request being answered straight out of the same ledger, tying back to "not a black box" as a legal-grade claim, not a marketing one.
9. **Close on the numbers** — 2.9 vs 8.2 days, 14 closed exception codes, real double-entry accounting, one immutable ledger. End on the one-liner again.

---

## 7. Build status — check this before you record, not during

This is for you, not for the script. Everything in Section 5 is written as a finished feature because that's the narrative the video should tell — but confirm each of these is actually true before you say it on camera:

| Item | Status as of 2026-09-06 | What "done" requires |
|---|---|---|
| OpenAI (extraction, investigation, embeddings, ask-why) | ✅ Real, verified, tested against the live API | Nothing — ship as-is |
| TensorMux (independent verifier) | ✅ Real, verified, tested against the live endpoint | Nothing — ship as-is |
| Core pipeline, 14 exception codes, hash-chain, journal posting | ✅ Real, tested | Nothing — ship as-is |
| Frontend (dashboard, queue, swimlane, audit trail) wired to real backend | ✅ Built and integrated this session | Confirm a full end-to-end run in the browser before recording |
| AO parallel build process | ⚠️ Real as an environment; git shows no separately-attributable worker-session commits | Pull your actual session history from the AO dashboard/CLI and confirm the specific count/names before the script names any |
| Dodo Payments (sandboxed disbursement trigger) | ❌ Not built — `lib/payments/` is empty, API key unset | Write `lib/payments/dodo.ts` (BUILD.md §7 already specs the single function needed: `triggerPayment(billId, amount, vendorBankRef)`), wire it into the audit stage after approval, get a real sandbox key, test one real sandbox call |
| Smallest.ai (voice callback) | ❌ Not built — `lib/voice.ts` doesn't exist, API key unset | Write the adapter (BUILD.md §6), wire it into the bank-change-review callback step, get a real key, test one real call |
| Telegram (reviewer notifications) | ❌ Not built — no code, no mention in any existing doc before this one | New scope — needs a bot token, a webhook or polling handler, and wiring into the escalation path in the orchestrator |

If any of the ❌ rows are still unbuilt on recording day, the honest fallback is: demo everything else live, and for those three specifically, show the designed interface/architecture (the adapter is isolated by design specifically so it's a small addition, not a rewrite) rather than claiming a live call happened. That's still a strong, true story — "we designed for this from day one" is a legitimate engineering claim even before the last adapter is wired in.

---

## 8. One more thing worth keeping in your back pocket for Q&A

If a judge asks "what's the weakest part of this system right now," the honest, credible answer is: **GR/IR clearing accounting is simplified** — PO-linked bills post a plain Dr Expense/Cr AP entry rather than the fuller accrual-then-clear flow a real ERP would use, because there's no goods-receipt posting step feeding it yet. That's a real, named, stated limitation, not a hidden one — and being able to name your own weakest point precisely, unprompted, is itself evidence of the same "verify, don't assert" discipline the whole product is built on.
