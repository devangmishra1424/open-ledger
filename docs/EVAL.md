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

- Real invoices. There is no labelled corpus of real documents here.
- Throughput and latency at volume (the provider tier used cannot sustain it).
- The matching engine's accuracy against an independent labelled set: it is covered by 130+ tests derived from the written spec in `docs/ap-three-way-match-spec.md`, which is a check of the implementation against the spec, not of the spec against the world.
