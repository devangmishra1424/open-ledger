-- Goods receipts read from a document: a delivery note / challan, a GRN or a packing slip can now be uploaded and
-- read into the receipt form, and the receipt keeps the original it came from (as invoices and POs already do).
-- Widens source_documents.purpose to include 'goods_receipt' and adds goods_receipts.source_document_id.
-- Additive (one wider CHECK, one nullable column); safe to re-run.
ALTER TABLE source_documents DROP CONSTRAINT IF EXISTS source_documents_purpose_check;
ALTER TABLE source_documents ADD CONSTRAINT source_documents_purpose_check
  CHECK (purpose IN ('invoice','purchase_order','goods_receipt'));
ALTER TABLE goods_receipts ADD COLUMN IF NOT EXISTS source_document_id TEXT REFERENCES source_documents(id);
