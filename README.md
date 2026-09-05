# Open Ledger

An Accounts-Payable agent (3-way match: PO ↔ Goods Receipt ↔ Invoice) that handles a comprehensive, closed exception taxonomy, routes anything uncertain through tiered human review, and — unlike everything else in this space — is genuinely not a black box: every agent, every handoff, every decision is interrogable, contestable, and backed by an immutable, hash-chained ledger. Built for Syndicate by Maximor, Track 2: Autonomous Office of the CFO.

**Status: design complete, code not yet started.** Everything below is ready to build from — no remaining open design questions.

## Start here, based on your role

**If you're building the UI:** read `DESIGN.md` §9 (screens) → the [published mockup](https://claude.ai/code/artifact/df6f8464-5edc-4b92-beb2-4890a7c46a40) → `UI_DESIGN_BRIEF.md` (motion/interaction direction, what to avoid) → `ENGINE.md` §7 (the full API contract you're building against — this is the corrected pointer; an earlier draft of this README sent you to `BUILD.md` §7, which is actually the Dodo Payments section, not the API) → `BUILD.md` §9 (your exact file ownership).

**If you're building the engine:** read `docs/ap-three-way-match-spec.md` (the exact matching/exception logic) → `ENGINE.md` (runtime architecture) → `ALGORITHMS.md` (every pseudocode/prompt detail, nothing left unspecified) → `BUILD.md` §1-§6 (repo structure, schema, types, API) and §9 (your file ownership).

**If you want the full picture first:** `DESIGN.md` → `docs/ap-three-way-match-spec.md` → `ENGINE.md` → `AUDIT.md` → `BUILD.md` → `ALGORITHMS.md` → `AUDIT_FINAL.md` (honest winnability audit) → `CITATIONS.md` (sources for every specific factual claim, including one correction) → `UI_DESIGN_BRIEF.md`. `SPEC.md` is superseded, kept for history only.

## First two commits, before anyone branches into their own half

1. `db/schema.sql` and `lib/types.ts`, copied verbatim from `BUILD.md` §2/§3.
2. `npm install && npm run migrate` works, empty pages render.

## File ownership (full detail in `BUILD.md` §9)

| Owner | Scope |
|---|---|
| Engine + AO | `db/` (except `schema.sql`, shared), `lib/matching/`, `lib/ledger/`, `lib/agent/`, `lib/pipeline/`, matching/pipeline tests, driving the AO sessions |
| UI + Wiring | `components/`, `app/**/page.tsx`, `app/api/*`, `lib/audit/`, `lib/embeddings.ts`, `lib/explain.ts`, `scripts/`, `lib/voice.ts`, `lib/payments/dodo.ts`, `tests/eval.test.ts` |
| Shared | `lib/types.ts`, `db/schema.sql` — agree before changing |

## Run it (once code exists)

```bash
npm install
npm run seed
npm run dev
```

No Docker, no login screen, no auth to click through.

## What track, and what's genuinely novel

Track 2, Autonomous Office of the CFO. The differentiator isn't "AI does AP" — every well-funded competitor already claims that. It's that the full closed loop (detect → gather evidence → propose with cited evidence → tiered approval → post to ledger) is genuinely inspectable and contestable at every step, backed by an accounting-correct, event-sourced ledger, not a status column. See `AUDIT_FINAL.md` for the honest, judge's-eye assessment of where this stands and what's still a risk.
