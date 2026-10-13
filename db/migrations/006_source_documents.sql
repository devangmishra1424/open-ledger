-- The original file behind an invoice or a purchase order, as uploaded (PDF, scan, photo, Word, Excel), with
-- what the document reader made of it and the fields read from it; invoices and POs link to it. Before, only
-- the extracted text was kept (vendor_bills.raw_source), so nobody could open the document an invoice came from.
-- Also: vendor_bills.adjustment_total (round-off and invoice-level discounts, signed) and the 7300 Rounding and
-- Discounts account it posts to, so an invoice whose total is "lines + tax + 0.34 round off" still balances in the
-- ledger. Additive (a new table, nullable/defaulted columns, one account row); safe to re-run.
CREATE TABLE IF NOT EXISTS source_documents (
  id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, filename TEXT NOT NULL, media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0), content BYTEA NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('invoice','purchase_order')),
  source_kind TEXT NOT NULL, page_count INTEGER, ocr_used BOOLEAN NOT NULL DEFAULT false, ocr_confidence NUMERIC(5,3),
  reading JSONB NOT NULL, extraction JSONB, uploaded_by TEXT,
  uploaded_at TEXT NOT NULL DEFAULT now()::text
);
CREATE INDEX IF NOT EXISTS idx_source_documents_sha256 ON source_documents(sha256);
ALTER TABLE vendor_bills ADD COLUMN IF NOT EXISTS source_document_id TEXT REFERENCES source_documents(id);
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS source_document_id TEXT REFERENCES source_documents(id);
ALTER TABLE vendor_bills ADD COLUMN IF NOT EXISTS adjustment_total NUMERIC(18,4) NOT NULL DEFAULT 0;
INSERT INTO chart_of_accounts (id, account_number, name, account_type, normal_balance, is_control_account)
  VALUES ('7300', '7300', 'Rounding and Discounts', 'expense', 'debit', false) ON CONFLICT DO NOTHING;
