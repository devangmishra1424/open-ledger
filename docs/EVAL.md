# Evaluation: what was measured, how, and what it does not show

Everything on this page was produced by a command in this repo. Nothing is estimated. Numbers come with the caveats that matter.

## 1. Extraction: how often is a document read wrong and still trusted?

```bash
npm run eval                      # deterministic path only: no model, no cost, reproducible
npm run eval -- --seed=7 --n=400  # another draw
npm run eval -- --llm             # also let the LLM fallback read what the template cannot (uses provider quota; not run for the numbers below)
```

`scripts/eval.ts` generates invoices from a seeded generator in two layouts, with ground truth, and damages some of them the way real documents get damaged. The extractor scores its own confidence from checks (required fields present, line items add up to the subtotal, subtotal + tax equals the total). A document below 0.85 confidence is sent to a person (the pipeline raises EXC-LAYOUT at 85%).

Result, 240 documents, seed 42 (seed 7 below it):

| document class | n | sent to a person | read exactly right | silent errors |
|---|---:|---:|---:|---:|
| clean (all fields present) | 69 | 0% | 100% | 0 |
| banner line above the vendor (ordinary) | 28 | 0% | 100% | 0 |
| labelled `Vendor:` header (ordinary) | 28 | 0% | 100% | 0 |
| total does not add up | 25 | 100% | 0% | 0 |
| invoice date missing | 27 | 100% | 0% | 0 |
| OCR digit swap (O for 0) | 22 | 100% | 100% | 0 |
| ambiguous date `03/04/2026` | 21 | 100% | 0% | 0 |
| layout the parser has never seen | 20 | 100% | 0% | 0 |

Damaged documents let through: **0 of 115**. Ordinary documents wrongly held for a person: **0 of 125**. Ordinary documents read wrong without a flag: **0**.
Seed 7: 0 of 122 damaged let through, 0 of 118 ordinary held, 0 read wrong without a flag.

*Silent error* = a document that was damaged (or had a wrong field) and was NOT sent to a person. That is the dangerous failure for an AP system, and it is the number to watch, not accuracy on clean documents.

### What this does and does not show

- **It validates the mechanism, not real-world performance.** I wrote both the generator and the checks, so the checks catch the faults the generator injects. Real invoices will contain failures neither of us thought of.
- **The first version of this benchmark was too easy and hid a real bug.** With only the damage classes above, it showed zero silent errors. Adding two *ordinary* variations (a banner line like "ORIGINAL FOR RECIPIENT" above the vendor name, and a labelled `Vendor:` header) exposed that the vendor-name heuristic read the wrong vendor on **44 of 125 ordinary documents with no flag** (labelled header: 28 of 28 wrong; banner line: 16 of 28 wrong). That was fixed (label support, boilerplate and letterhead-contact skipping) and the tests that pin it were mutation-checked: removing the fix makes them fail.
- **The one field the arithmetic cannot check is the vendor name.** When it is found by position rather than by a label, the extraction says so (`vendor_name taken from the document header (heuristic)` in `uncertain_fields`). The vendor is then matched against the vendor master at intake; an unknown vendor is created with trust tier `new`.
- **The LLM fallback path is not in these numbers.** It is exercised by one live test (a free-form invoice in a layout the template cannot read) and the same arithmetic checks apply to what it returns; its self-reported confidence can only lower the score.

## 2. Model choice for the Investigator (live provider)

```bash
npm run bench:llm -- 6        # runs in its own schema, veribook_bench
```

Six back-to-back runs per model on a clean three-way match, Groq free tier, 8 October 2026:

| model | completed | median s | notes |
|---|---:|---:|---|
| `openai/gpt-oss-120b` | 5/6 | 25 | 3 invalid-tool-call re-samples; one run still failed after two re-samples (the limit is now three); confidence 0.94-0.97 |
| `openai/gpt-oss-20b` | 6/6 | 20 | 3 re-samples; reported confidence as `100` instead of `1.0` once (now normalised at the boundary) |
| `qwen/qwen3.8-27b` | 6/6 | 50 | no re-samples; slowest; confidence 0.72-0.95 |

How to read it: **the times are mostly provider rate-limit waiting** (the runs are back to back, and the free tier caps `gpt-oss-120b` at 8,000 tokens per minute and 200,000 per day), not model speed. Unthrottled, a single investigation took 2-5 seconds. There is no clear winner, so: Investigator on `gpt-oss-120b`, Verifier on Qwen, deliberately different families so the second opinion is independent, both configurable by environment variable (`INVESTIGATOR_MODEL`, `VERIFIER_MODEL`). The model id the original code hard-coded (`llama-3.3-70b-versatile`) had been retired by the provider, which is why every AI step was returning 404.

Reliability work this produced, all covered by tests with a fake provider client (`tests/agent-loop.test.ts`): bounded re-sampling when the model emits an invalid tool call (a 400 where asking again is a different outcome), four SDK retries with backoff for 429s, a plain-language error when a daily quota is hit, reasoning effort set to low for reasoning models, and confidence normalised to 0-1 whatever scale the model used.

Observed on the demo data, from the Pipeline screen: the Investigator failed on 1 of 7 runs (a daily-quota 429, which I inspected) and the Verifier on 1 of 3 (cause not inspected). Those invoices stopped with `R99_AGENT_ERROR`, a person sees "The automated review did not finish" with the real cause, and "Retry AI review" re-runs it.

## 3. Test suite

`npm test` (or `SKIP_LIVE_LLM=1 npm test` to skip the suites that call the provider and spend quota). The suite runs in its own database schema (`veribook_test`), rebuilt each run; the live tables are never touched. Counts are in the repo README and the CI log; they are not duplicated here so they cannot go stale.

Properties that are tested as properties, not just examples:

- an approve and a reject racing on the same invoice: exactly one wins, and a rejected invoice never reaches the ledger;
- the same approval submitted twice produces one decision, one ledger entry, one payment;
- paying the same bill three times concurrently pays once;
- a model's "auto_approve" cannot move money for an invoice the deterministic rules flagged (checked by mutation: restoring the old behaviour makes the test fail);
- the vendor bank-change control: hold, callback, attested outcome, different-person sign-off, release, approval;
- the whole decision chain verifies after every human action.

## 4. Not measured

- Real invoices. There is no labelled corpus of real vendors' documents here; the document test set (section 5) is generated.
- Throughput and latency at volume (the provider tier used cannot sustain it).
- The matching engine's accuracy against an independent labelled set: it is covered by 130+ tests derived from the written spec in `docs/ap-three-way-match-spec.md`, which is a check of the implementation against the spec, not of the spec against the world.

## 5. Reading documents: scans, photos, Word, Excel (October 2026)

**What:** the whole document path, reader (Docling + RapidOCR + page cleanup) and field extraction (layout rules, AI only for gaps), scored field by field against answer keys. `eval/documents/run.ts`; the test set and its answer keys are built by `eval/documents/generate.py`.

**The test set:** 8 invoice layouts written to look like real ones (a Tally-style GST tax invoice with CGST + SGST, round off and an HSN summary table; a Zoho-style IGST invoice with per-line tax columns and DD/MM dates; a chartered accountant's bill with amount-only rows and lakh grouping; a US invoice with quantity first, MM/DD dates, sales tax and shipping; a UK VAT invoice; a 28-line invoice over two pages; a trader's bill with line discounts and KG quantities; a small vendor's bill with no table at all). Each comes in up to 6 forms made from the printed PDF: the digital PDF, a clean 200 dpi scan, a messy scan (150 dpi, 1.2-2.2 degree skew, blur, speckle, JPEG artefacts), a phone photo (perspective, a desk around the page, uneven light), a screenshot, and for some a Word or Excel file. 39 documents, 9 fields each = 351 fields. The answer keys are computed from the same numbers that printed the documents.

**Outcomes per field:** right; wrong but flagged (named in the reading's unsure fields, or the reading is under the 85% bar, so a person checks it before anything is paid); SILENT (wrong and not flagged). SILENT is the number that matters.

| | Fields right | Wrong but flagged | Silent | Documents fully right |
|---|---|---|---|---|
| Layout rules only (no AI) | 346 / 351 (98.6%) | 5 | 0 | 35 / 39 |
| Rules, then the AI for gaps (values must be printed) | 348 / 351 (99.1%) | 3 | 0 | 37 / 39 |

The AI ran on 3 of the 39 documents. What is still wrong: the deliberately wrecked scan of the service bill (lines garbled by OCR; flagged), and the Excel copy of the US invoice, which states no currency and writes 10/02/2026 with no country to go by (both fields flagged: that is the right answer for that file). Run-to-run, the AI's answer varies: in one of three runs it paired a printed list price (640) with a printed discounted amount (15,200) on one line. Both numbers are on the page, so grounding passed; the line check (quantity x price must equal the amount) caught it and flagged it. Three repeated runs: 0 silent errors each.

**Speed (laptop CPU, models loaded):** Word/Excel 0.1 s; digital PDF 1-7 s; a scan or photo 3-14 s a page. The first versions took 60-70 s on the Tally layout (Docling's ACCURATE table model on a dense grid); FAST mode takes 6-8 s with the same fields, because the fields are read from the page layout, not from the table model.

**Purchase orders:** 5 PO documents (digital, scan, photo, messy scan; two layouts) read with every field right, the vendor taken from the Vendor/Supplier block and never from the buyer's letterhead.

**What this does not show:** these are generated documents, so their fonts, layouts and damage are ones I chose; real vendors' invoices (and real phone photos) will find cases these do not. No handwriting, no Hindi/Devanagari (RapidOCR's models here read Latin script), no page photographed sideways. Speed is one laptop, one document at a time. CI scores the field rules on the 44 saved reader outputs in `eval/documents/readings/` (`--no-llm --cached-only --min-correct 340`, failing on any silent error); the reader itself is tested locally with its models (`docreader/tests`).
