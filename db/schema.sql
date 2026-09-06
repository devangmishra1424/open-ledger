-- Postgres (Supabase) schema. Switched from SQLite: booleans are real BOOLEAN (not 0/1),
-- timestamps default to now()::text (kept as TEXT, not TIMESTAMPTZ, so the app's existing
-- ISO-string handling doesn't need to change), and `decisions` gets an explicit BIGSERIAL
-- `seq` column since Postgres has no implicit rowid to order the hash chain by.

CREATE TABLE chart_of_accounts (
  id TEXT PRIMARY KEY, account_number TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('asset','liability','equity','revenue','expense')),
  account_subtype TEXT, normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit','credit')),
  parent_account_id TEXT REFERENCES chart_of_accounts(id),
  is_control_account BOOLEAN NOT NULL DEFAULT false, currency TEXT, is_active BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE accounting_periods (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','permanently_closed'))
);
CREATE TABLE vendors (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, remit_to_address TEXT, bank_account_last4 TEXT,
  bank_account_changed_at TEXT, trust_tier TEXT NOT NULL DEFAULT 'new' CHECK (trust_tier IN ('trusted','new','flagged')),
  tax_id TEXT, w9_on_file BOOLEAN NOT NULL DEFAULT false, payment_terms_code TEXT,
  created_at TEXT NOT NULL DEFAULT now()::text
);
CREATE TABLE vendor_bank_change_reviews (
  id TEXT PRIMARY KEY, vendor_id TEXT NOT NULL REFERENCES vendors(id),
  old_bank_last4 TEXT, new_bank_last4 TEXT,
  status TEXT NOT NULL DEFAULT 'callback_pending' CHECK (status IN ('callback_pending','callback_confirmed','callback_failed')),
  callback_phone_used TEXT, callback_confirmed_by TEXT, callback_at TEXT,
  second_reviewer_name TEXT, source_invoice_id TEXT,
  created_at TEXT NOT NULL DEFAULT now()::text
);
CREATE TABLE vendor_corrections (
  id TEXT PRIMARY KEY, vendor_id TEXT NOT NULL REFERENCES vendors(id), pattern TEXT NOT NULL,
  note TEXT, source_invoice_id TEXT, created_at TEXT NOT NULL DEFAULT now()::text,
  -- UOM-conversion extension (ALGORITHMS.md §14: "a natural, cheap extension of the existing
  -- vendor_corrections learning-loop mechanism" rather than a parallel table). Only populated
  -- when this correction records a confirmed unit-of-measure conversion factor; NULL otherwise.
  uom_from TEXT, uom_to TEXT, conversion_factor REAL
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
  id TEXT PRIMARY KEY, po_number TEXT UNIQUE NOT NULL, vendor_id TEXT NOT NULL REFERENCES vendors(id), buyer_name TEXT,
  order_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','partial','closed')),
  po_type TEXT NOT NULL DEFAULT 'standard' CHECK (po_type IN ('standard','blanket')),
  max_value_ceiling REAL, max_qty_ceiling REAL,
  currency TEXT NOT NULL DEFAULT 'USD', exchange_rate REAL NOT NULL DEFAULT 1.0
);
CREATE TABLE purchase_order_lines (
  id TEXT PRIMARY KEY, po_id TEXT NOT NULL REFERENCES purchase_orders(id), line_number INTEGER NOT NULL,
  description TEXT NOT NULL, uom TEXT NOT NULL DEFAULT 'each', qty_ordered REAL NOT NULL,
  unit_price REAL NOT NULL, gl_account_id TEXT REFERENCES chart_of_accounts(id),
  tolerance_pct REAL NOT NULL DEFAULT 0.02, final_delivery BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE goods_receipts (
  id TEXT PRIMARY KEY, po_id TEXT NOT NULL REFERENCES purchase_orders(id), receipt_date TEXT NOT NULL,
  receiver_name TEXT, condition TEXT NOT NULL DEFAULT 'accepted' CHECK (condition IN ('accepted','damaged','rejected')),
  final_delivery_indicator BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE goods_receipt_lines (
  id TEXT PRIMARY KEY, goods_receipt_id TEXT NOT NULL REFERENCES goods_receipts(id),
  po_line_id TEXT NOT NULL REFERENCES purchase_order_lines(id), qty_received REAL NOT NULL
);
CREATE TABLE journal_entries (
  id TEXT PRIMARY KEY, entry_number TEXT UNIQUE NOT NULL, entry_date TEXT NOT NULL,
  period_id TEXT NOT NULL REFERENCES accounting_periods(id), memo TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('vendor_bill','payment','manual','reversal')), source_id TEXT,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('draft','posted','reversed','voided')),
  posted_by TEXT, posted_at TEXT, reversal_of_entry_id TEXT REFERENCES journal_entries(id),
  currency TEXT NOT NULL DEFAULT 'USD', exchange_rate REAL NOT NULL DEFAULT 1.0,
  idempotency_key TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT now()::text
);
CREATE TABLE journal_entry_lines (
  id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES journal_entries(id), line_number INTEGER NOT NULL,
  account_id TEXT NOT NULL REFERENCES chart_of_accounts(id),
  debit_amount REAL NOT NULL DEFAULT 0, credit_amount REAL NOT NULL DEFAULT 0,
  currency_amount REAL NOT NULL, base_currency_amount REAL NOT NULL,
  department TEXT, class TEXT, location TEXT, vendor_id TEXT REFERENCES vendors(id)
);
CREATE TABLE vendor_bills (
  id TEXT PRIMARY KEY, vendor_id TEXT NOT NULL REFERENCES vendors(id), po_id TEXT REFERENCES purchase_orders(id),
  invoice_number TEXT NOT NULL, invoice_date TEXT NOT NULL, due_date TEXT,
  currency TEXT NOT NULL DEFAULT 'USD', exchange_rate REAL NOT NULL DEFAULT 1.0,
  subtotal REAL NOT NULL, tax_total REAL NOT NULL DEFAULT 0, total_amount REAL NOT NULL,
  raw_source TEXT, ap_account_id TEXT REFERENCES chart_of_accounts(id), journal_entry_id TEXT REFERENCES journal_entries(id),
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','matched','exception','approved','posted','paid','void')),
  -- EXC-CREDIT_MEMO extension (spec §2 EXC-07): invoice_type distinguishes a credit memo from
  -- a standard bill; related_invoice_id is the original invoice it nets against (spec's own
  -- detection logic: "credit_memo.related_invoice_number references an existing... invoice").
  -- Both NULL/'standard' for every ordinary bill — additive, no existing row changes meaning.
  invoice_type TEXT NOT NULL DEFAULT 'standard' CHECK (invoice_type IN ('standard', 'credit_memo')),
  related_invoice_id TEXT REFERENCES vendor_bills(id),
  received_at TEXT NOT NULL DEFAULT now()::text, UNIQUE(vendor_id, invoice_number)
);
CREATE TABLE vendor_bill_lines (
  id TEXT PRIMARY KEY, vendor_bill_id TEXT NOT NULL REFERENCES vendor_bills(id),
  po_line_id TEXT REFERENCES purchase_order_lines(id), description TEXT NOT NULL,
  qty_invoiced REAL NOT NULL, unit_price REAL NOT NULL, uom TEXT NOT NULL DEFAULT 'each',
  tax_code_id TEXT REFERENCES tax_codes(id), gl_account_id TEXT REFERENCES chart_of_accounts(id),
  -- EXC-TAX_VAR extension: the tax actually charged on THIS line, vs tax_codes.rate (the
  -- expected rate for tax_code_id) — tax_total on vendor_bills is only a header aggregate and
  -- can't be broken down per line when a bill has lines under different tax codes. Nullable:
  -- most demo/seed lines won't set it, and no tax comparison fires without it (see match-stage.ts).
  tax_amount REAL
);
CREATE TABLE payments (
  id TEXT PRIMARY KEY, method TEXT NOT NULL DEFAULT 'ach' CHECK (method IN ('ach','wire','check','virtual_card')),
  payment_date TEXT NOT NULL, bank_account_id TEXT, total_amount REAL NOT NULL,
  journal_entry_id TEXT REFERENCES journal_entries(id), positive_pay_reference TEXT
);
CREATE TABLE payment_applications (
  id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payments(id),
  vendor_bill_id TEXT NOT NULL REFERENCES vendor_bills(id), applied_amount REAL NOT NULL
);
CREATE TABLE reason_codes (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL
);
CREATE TABLE decisions (
  seq BIGSERIAL,
  id TEXT PRIMARY KEY, invoice_id TEXT REFERENCES vendor_bills(id),
  node_id TEXT NOT NULL CHECK (node_id IN ('extract','validate','match','investigate','verify','policy','audit','audit_assemble')),
  parent_decision_id TEXT REFERENCES decisions(id), reconsideration_of_id TEXT REFERENCES decisions(id),
  superseded_by_id TEXT REFERENCES decisions(id), agent_id TEXT NOT NULL, model TEXT, model_version TEXT,
  started_at TEXT NOT NULL, ended_at TEXT,
  inputs_consumed TEXT, tool_calls TEXT, claims TEXT, policy_evaluation TEXT,
  confidence REAL, action_taken TEXT, reason_code TEXT REFERENCES reason_codes(code),
  forwarded_to TEXT, what_was_forwarded TEXT, triggered_by_actor TEXT, triggered_by_question TEXT,
  idempotency_key TEXT UNIQUE, prev_hash TEXT, hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT now()::text
);
CREATE TABLE reviews (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES vendor_bills(id), reviewer_name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('approve','reject','request_info','contest')),
  reason_code TEXT REFERENCES reason_codes(code), note TEXT, decision_id TEXT REFERENCES decisions(id),
  created_at TEXT NOT NULL DEFAULT now()::text
);
CREATE TABLE pbc_requests (
  id TEXT PRIMARY KEY,
  item_type TEXT NOT NULL CHECK (item_type IN ('trial_balance','ap_aging','invoice_bundle','tie_out_check','surl_check')),
  description TEXT NOT NULL, covered_period_id TEXT REFERENCES accounting_periods(id),
  due_date TEXT, owner_name TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','assembled','submitted','accepted','exception')),
  linked_invoice_ids TEXT, created_at TEXT NOT NULL DEFAULT now()::text
);
-- PBC evidence file attachments (real auditor-facing files — a signed confirmation letter, a
-- W-9, a bank statement — attached as supporting evidence for one PBC request). Content stored
-- as base64 TEXT rather than an external object store: additive, no new infra dependency, fine
-- at hackathon-demo file sizes; a real production system would put content_base64 in S3/blob
-- storage and keep only a pointer here.
CREATE TABLE pbc_evidence_files (
  id TEXT PRIMARY KEY, pbc_request_id TEXT NOT NULL REFERENCES pbc_requests(id),
  filename TEXT NOT NULL, content_type TEXT, content_base64 TEXT NOT NULL,
  uploaded_by TEXT, uploaded_at TEXT NOT NULL DEFAULT now()::text
);
-- Single-row app settings, real persistence for the Settings page. NOT yet read by
-- lib/matching/decision-matrix.ts (its thresholds are still real hardcoded constants) — this
-- table makes "Save Configuration" a genuine, persisted write, not a fake alert; wiring these
-- values into live policy evaluation is a separate, larger change (decision-matrix.ts's
-- thresholds are unit-tested against the spec's own worked examples as fixed constants today).
CREATE TABLE app_settings (
  id TEXT PRIMARY KEY DEFAULT 'default',
  auto_approval_confidence REAL NOT NULL DEFAULT 95.0,
  max_auto_payment_amount REAL NOT NULL DEFAULT 50000.00,
  erp_webhook_url TEXT,
  updated_at TEXT NOT NULL DEFAULT now()::text
);
CREATE INDEX idx_decisions_invoice ON decisions(invoice_id);
CREATE INDEX idx_decisions_seq ON decisions(seq);
CREATE INDEX idx_vendor_bills_vendor ON vendor_bills(vendor_id);
CREATE INDEX idx_jel_account ON journal_entry_lines(account_id);
CREATE INDEX idx_pbc_evidence_files_request ON pbc_evidence_files(pbc_request_id);
