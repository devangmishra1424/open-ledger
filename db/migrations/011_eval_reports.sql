-- Saved evaluation reports (lib/evals/report.ts): a lab run of the labelled cases (eval/decisions/run.ts) or a field
-- report over a period, read from the decision trail. Kept so the Quality page can list them and say what changed
-- since the last one. New table only; nothing existing changes. Safe to re-run.
CREATE TABLE IF NOT EXISTS eval_reports (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('lab','field')), mode TEXT NOT NULL CHECK (mode IN ('rules','rules+ai','field')),
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','fail','not_enough_data')), summary TEXT NOT NULL,
  period_from TEXT, period_to TEXT, code_version TEXT, created_by TEXT,
  report JSONB NOT NULL, created_at TEXT NOT NULL DEFAULT now()::text
);
CREATE INDEX IF NOT EXISTS idx_eval_reports_kind_created ON eval_reports(kind, created_at DESC);

-- Two pre-match checks had no reason code of their own, so an invoice held for a future date or a flagged vendor
-- recorded "Clean Match" as its reason (found by the lab run). They now record these.
INSERT INTO reason_codes (code, name, description) VALUES
  ('INVOICE_DATE', 'Invoice Date Out of Range', 'The invoice date is in the future or more than a year old: held for a person before any matching (spec §1.2, anti-fraud).'),
  ('VENDOR_FLAGGED', 'Vendor Flagged', 'The vendor is flagged: nothing from it is processed automatically until a person clears it.')
ON CONFLICT (code) DO NOTHING;
