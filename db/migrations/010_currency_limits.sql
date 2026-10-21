-- The auto-approval limit was one number compared with every invoice whatever its currency: an INR 1,06,200 invoice
-- (about USD 1,270) was held by a 50,000 limit, while a GBP 49,000 one (over USD 60,000) would have gone through.
-- The limit is now per currency: max_auto_payment_amount stays the USD limit, and currency_limits holds the others as
-- JSON {"INR": 4000000}. INR starts at 40,00,000 (roughly USD 50,000; change it in Settings). An invoice in a
-- currency with no limit set always goes to a person. Additive; safe to re-run.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS currency_limits TEXT NOT NULL DEFAULT '{"INR": 4000000}';
