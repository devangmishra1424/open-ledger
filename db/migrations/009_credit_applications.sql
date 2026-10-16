-- Credit memos used against a vendor's invoices: one row per use, saying which invoice took how much of
-- which credit. Before this, an approved credit came off only its own invoice's payment, and only while
-- that invoice was unpaid; that use was implicit (posted credits summed by related_invoice_id), and a
-- credit left over once that invoice was paid was never used. With the uses recorded, the leftover comes
-- off the same vendor's later invoices in the same currency, and no part of a credit is used twice.
-- Additive (one new table), plus a backfill that writes today's implicit uses as rows: a posted credit
-- memo came off its own invoice by as much as that invoice's payment fell short of its total (all of
-- its total while it is unpaid; nothing if it is marked paid with no payment on file, as seeded data
-- can be), oldest credit first. Without the backfill, a credit already taken off a payment would look
-- unused and come off the next invoice as well. Safe to re-run.
CREATE TABLE IF NOT EXISTS credit_applications (
  id TEXT PRIMARY KEY,
  credit_memo_id TEXT NOT NULL REFERENCES vendor_bills(id),
  vendor_bill_id TEXT NOT NULL REFERENCES vendor_bills(id),
  applied_amount NUMERIC(18,4) NOT NULL CHECK (applied_amount > 0),
  created_at TEXT NOT NULL DEFAULT now()::text,
  UNIQUE (credit_memo_id, vendor_bill_id)
);
CREATE INDEX IF NOT EXISTS idx_credit_applications_bill ON credit_applications(vendor_bill_id);

INSERT INTO credit_applications (id, credit_memo_id, vendor_bill_id, applied_amount)
SELECT 'ca-009-' || c.id, c.id, c.related_invoice_id, LEAST(c.total_amount, c.room - c.earlier)
FROM (
  SELECT cm.id, cm.related_invoice_id, cm.total_amount,
         -- credits on the same invoice that come before this one
         SUM(cm.total_amount) OVER (PARTITION BY cm.related_invoice_id ORDER BY cm.invoice_date, cm.received_at, cm.id)
           - cm.total_amount AS earlier,
         -- what the invoice's payment left unpaid: the part its credits took
         CASE WHEN inv.status = 'paid' AND pay.paid IS NULL THEN 0
              ELSE inv.total_amount - COALESCE(pay.paid, 0) END AS room
  FROM vendor_bills cm JOIN vendor_bills inv ON inv.id = cm.related_invoice_id
  LEFT JOIN LATERAL (SELECT SUM(pa.applied_amount) AS paid FROM payment_applications pa WHERE pa.vendor_bill_id = inv.id) pay ON true
  WHERE cm.invoice_type = 'credit_memo' AND cm.journal_entry_id IS NOT NULL
) c
WHERE c.room - c.earlier > 0
ON CONFLICT (credit_memo_id, vendor_bill_id) DO NOTHING;
