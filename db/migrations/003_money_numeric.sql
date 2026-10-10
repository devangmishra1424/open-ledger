-- Money, quantities and rates move from REAL (4-byte float, ~7 significant digits: a $16,777,217.00
-- invoice cannot be stored to the cent) to NUMERIC (exact). Confidence scores stay REAL.
--
-- REVIEW BEFORE APPLYING TO A POPULATED DATABASE. Existing REAL values convert via round(x::numeric, N);
-- Postgres converts float4 to numeric at 6 significant digits, so a stored amount of 123456.78 is
-- already 123456.8 in the database and converts as such. The demo data (largest invoice < $40,000)
-- is unaffected. Rehearse on a copy (DB_SCHEMA=<demo schema>) first.
-- Runs in one transaction (apply-migration.ts), so it either all converts or none does.
ALTER TABLE vendor_corrections ALTER COLUMN conversion_factor TYPE NUMERIC(18,8) USING round(conversion_factor::numeric, 8);
ALTER TABLE tax_codes ALTER COLUMN rate TYPE NUMERIC(10,6) USING round(rate::numeric, 6);
ALTER TABLE exchange_rates ALTER COLUMN rate TYPE NUMERIC(18,8) USING round(rate::numeric, 8);
ALTER TABLE purchase_orders ALTER COLUMN max_value_ceiling TYPE NUMERIC(18,4) USING round(max_value_ceiling::numeric, 4);
ALTER TABLE purchase_orders ALTER COLUMN max_qty_ceiling TYPE NUMERIC(18,4) USING round(max_qty_ceiling::numeric, 4);
ALTER TABLE purchase_orders ALTER COLUMN exchange_rate TYPE NUMERIC(18,8) USING round(exchange_rate::numeric, 8);
ALTER TABLE purchase_order_lines ALTER COLUMN qty_ordered TYPE NUMERIC(18,4) USING round(qty_ordered::numeric, 4);
ALTER TABLE purchase_order_lines ALTER COLUMN unit_price TYPE NUMERIC(18,4) USING round(unit_price::numeric, 4);
ALTER TABLE purchase_order_lines ALTER COLUMN tolerance_pct TYPE NUMERIC(8,6) USING round(tolerance_pct::numeric, 6);
ALTER TABLE goods_receipt_lines ALTER COLUMN qty_received TYPE NUMERIC(18,4) USING round(qty_received::numeric, 4);
ALTER TABLE journal_entries ALTER COLUMN exchange_rate TYPE NUMERIC(18,8) USING round(exchange_rate::numeric, 8);
ALTER TABLE journal_entry_lines ALTER COLUMN debit_amount TYPE NUMERIC(18,4) USING round(debit_amount::numeric, 4);
ALTER TABLE journal_entry_lines ALTER COLUMN credit_amount TYPE NUMERIC(18,4) USING round(credit_amount::numeric, 4);
ALTER TABLE journal_entry_lines ALTER COLUMN currency_amount TYPE NUMERIC(18,4) USING round(currency_amount::numeric, 4);
ALTER TABLE journal_entry_lines ALTER COLUMN base_currency_amount TYPE NUMERIC(18,4) USING round(base_currency_amount::numeric, 4);
ALTER TABLE vendor_bills ALTER COLUMN exchange_rate TYPE NUMERIC(18,8) USING round(exchange_rate::numeric, 8);
ALTER TABLE vendor_bills ALTER COLUMN subtotal TYPE NUMERIC(18,4) USING round(subtotal::numeric, 4);
ALTER TABLE vendor_bills ALTER COLUMN tax_total TYPE NUMERIC(18,4) USING round(tax_total::numeric, 4);
ALTER TABLE vendor_bills ALTER COLUMN total_amount TYPE NUMERIC(18,4) USING round(total_amount::numeric, 4);
ALTER TABLE vendor_bill_lines ALTER COLUMN qty_invoiced TYPE NUMERIC(18,4) USING round(qty_invoiced::numeric, 4);
ALTER TABLE vendor_bill_lines ALTER COLUMN unit_price TYPE NUMERIC(18,4) USING round(unit_price::numeric, 4);
ALTER TABLE vendor_bill_lines ALTER COLUMN tax_amount TYPE NUMERIC(18,4) USING round(tax_amount::numeric, 4);
ALTER TABLE payments ALTER COLUMN total_amount TYPE NUMERIC(18,4) USING round(total_amount::numeric, 4);
ALTER TABLE payment_applications ALTER COLUMN applied_amount TYPE NUMERIC(18,4) USING round(applied_amount::numeric, 4);
ALTER TABLE app_settings ALTER COLUMN max_auto_payment_amount TYPE NUMERIC(18,4) USING round(max_auto_payment_amount::numeric, 4);
