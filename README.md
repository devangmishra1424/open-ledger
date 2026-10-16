# VeriBook (Open Ledger)

Accounts-payable invoice processing with a three-way match (purchase order, goods receipt, invoice). Invoices come in, are read, checked against the PO and the delivery, and either approved and posted to a double-entry ledger or put in front of a person with the reason. Every decision, including each human approval, is chained to the one before it with SHA-256, so the history is tamper-evident.

It is a working system, not a mock-up, and it is explicit about what is real and what is simulated.

## The idea in one paragraph

Deterministic code makes the money decisions; AI is used where judgment is needed and is never allowed to loosen a rule. A rules engine does the matching and applies the approval policy. An AI Investigator looks into exceptions with tools (vendor history, PO lookup), a second AI from a different model family double-checks it, and either can only make the outcome *stricter*. People decide the rest, and what they decide is recorded in the same audit chain as the machine's steps.

## What is real and what is simulated

| | Status |
|---|---|
| Reading invoices, POs and goods receipts from documents | Real. PDFs (digital or scanned), phone photos, Word, Excel: a document reader (Docling + RapidOCR, with scanner-style page cleanup) and then layout rules; an AI model only fills what the rules could not read, and only with values printed in the document. Every line and total is checked to add up; a person checks the filled form (for an invoice, beside the original) before anything is saved. On 39 test invoices: 348/351 fields right, every wrong one flagged (`docs/EVAL.md` section 5). |
| Three-way matching, tolerances, exception taxonomy (14 codes), approval policy | Real. Deterministic; from the written spec in `docs/ap-three-way-match-spec.md`. |
| AI investigation and second-opinion review | Real, on Groq (`openai/gpt-oss-120b` and `qwen/qwen3.8-27b` by default, configurable). Subject to the provider's free-tier quotas. |
| Double-entry ledger, accounting periods | Real. Balanced journal entries in Postgres; a month's period is opened on first use; closed periods block posting. |
| Audit chain | Real. Append-only, SHA-256 chained, recomputed from the first record on demand. Tamper-evident, not a blockchain. |
| Ask by voice | Real, read-only. The browser's own speech recognition and voice, on top of the existing explain endpoint (answers only from recorded decisions). Chrome and Edge for the microphone; typing works everywhere. See `docs/HOW_IT_WORKS.md` section 10b. |
| **Payments** | **Simulated.** Recorded and posted (Dr AP / Cr Cash), no money moves. Every screen says so. |
| **Vendor bank-detail callbacks** | **Manual.** A person phones the vendor and records the answer; a different person signs off. No automated call is placed. |
| Sign-in | Off by default: VeriBook runs as an open proof of concept, entered straight from the home page, with reviewer names typed in. Optional, and real when switched on (`VERIBOOK_USERS`, `VERIBOOK_AUTH_SECRET`): named accounts with scrypt-hashed passwords, signed session tokens, every API route behind it, decisions recorded under the signed-in account. No roles yet. See `docs/HOW_IT_WORKS.md` section 9b. |

## Try it

```bash
npm install
cp .env.example .env            # DATABASE_URL (Supabase/Postgres), GROQ_API_KEY
# one-time: a demo database schema, separate from the live tables
DB_SCHEMA=veribook_demo npm run migrate
DB_SCHEMA=veribook_demo npm run seed       # 8 invoices through the real pipeline (uses AI quota)
npm run dev:demo                 # API on :3001, against the demo schema
npm --prefix frontend install && npm --prefix frontend run dev   # UI on :5173

# the document reader (Python 3.12; about 2 GB of packages, 1.1 GB of memory when running)
python -m venv docreader/.venv
docreader/.venv/Scripts/pip install -r docreader/requirements.txt   # bin/pip on Linux/macOS
npm run reader                   # on :8090; the first start downloads the layout/table models
```

Add an invoice with **Add invoice → From a document**: drop a PDF, a scan or a phone photo (or pick one of the samples), check the filled form beside the original, and save. Without the reader running, documents are refused with a 503 that says so; typed-in invoices still work.

The home page is at http://localhost:5173; **Enter VeriBook** goes straight to the workbench at `/app`. There is no sign-in unless you configure accounts (`VERIBOOK_USERS` and `VERIBOOK_AUTH_SECRET`, see `.env.example`).

Open the inbox. Six invoices will be waiting, each for a different reason: a bank-detail change on the vendor, a price variance, a unit-of-measure mismatch, a missing PO, a blanket-PO ceiling, a credit memo. Open the bank-detail one and walk the verification: log the call, record the vendor's answer, then sign off as a second person (with sign-in on, sign in as a second account; with it off, switch name in the sidebar); only then can it be approved.

`npm run migrate` and the demo-wipe scripts refuse to touch the live schema without `--yes`.

## Hosting it

One Vercel project serves everything: `npm run build` builds the frontend (`build:web`), copies it into `public/`, then runs `next build`; the API is the Next.js routes and every other path gets the single-page app. The build needs no secret. `vercel.json` runs the functions in Mumbai (`bom1`), next to the Supabase database. Set these in the Vercel project (Settings, Environment Variables), then redeploy:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the **pooled** Supabase string (port 6543) |
| `DB_SCHEMA` | `veribook_demo`, so the hosted copy works on the demo tables and never the live `public` ones |
| `GROQ_API_KEY` | the AI provider key (without it every AI step says it could not run and stops the invoice for a person) |
| `DB_POOL_MAX` | `5` (each serverless instance holds its own pool) |

Check it with `GET /api/system`, then open `/app`. Limits of a hosted copy: the document reader is a separate Python service of about 2 GB and does not run on Vercel, so **From a document** answers 503 with the reason (typed-in invoices, POs and receipts work); sign-in is off, so anyone with the link can approve invoices and spend the AI quota (see Known limits).

## Checks

```bash
npm run typecheck
npm test                        # runs in its own schema (veribook_test); live tables are never touched
SKIP_LIVE_LLM=1 npm test        # skip the suites that call the AI provider and spend quota
npm run eval                    # extraction benchmark: deterministic, no cost  (docs/EVAL.md)
npx tsx eval/documents/run.ts --no-llm --cached-only   # document reading, scored on 39 saved real reader outputs (CI runs this)
npm run eval:documents          # the same through the running reader, with the AI pass (uses quota)
docreader/.venv/Scripts/python -m pytest docreader/tests   # the reader itself, with the real models
npm run bench:llm -- 6          # compare candidate models for the Investigator
```

## Where to read next

- **`docs/HOW_IT_WORKS.md`**: each feature, how it works, why it was built that way, how it fails, and what is still weak. Written to be explained from.
- **`docs/EVAL.md`**: what was measured, how, and what the numbers do not show.
- `docs/ap-three-way-match-spec.md`: the matching and exception spec the engine implements.
- `DESIGN.md`, `ENGINE.md`, `ALGORITHMS.md`, `BUILD.md`, `AUDIT*.md`, `UI_DESIGN_BRIEF.md`, `SPEC.md`: the original design documents from before the code existed. They describe intent and some of it has since changed (the AI provider, the payment rail, the UI); where they disagree with `docs/HOW_IT_WORKS.md`, the latter is right.

## Known limits

- Single tenant, and open by default: with sign-in off (the default) anyone with the link can use it and reviewer identity is a typed name. Sign-in, when switched on, has accounts but no roles: any signed-in account can approve.
- Goods-receipt documents (delivery note / challan, GRN, packing slip) are read by layout rules only, no AI: what the rules miss is typed in. The 7 test receipt documents are generated, like the test invoices.
- OCR reads English (Latin script). A Hindi / Devanagari invoice, handwriting, a page photographed sideways, or an invoice split across several photos is not read; the reader says so or a person types the fields. The test invoices are generated, not real vendors' invoices.
- The document reader is a separate Python service of about 2 GB (Docling, PyTorch, OCR models) and reads one document at a time.
- Payments are a simulation, made at approval rather than scheduled by due date or early-payment terms.
- One currency in the ledger: invoices carry a currency, but there is no FX conversion and amounts are not summed across currencies.
- No goods-receipt accrual (GR/IR clearing); bills post Dr Expense / Cr AP.
- Voice input is the browser's: Chrome and Edge only, over https or localhost, and the recording goes to the browser vendor's speech service. Misheard words give a wrong answer, never an action.
- AI steps depend on a provider whose free tier caps tokens per minute and per day; a capped step stops the invoice for a person with the reason, and "Retry AI review" re-runs it.
