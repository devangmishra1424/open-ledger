-- Reason-code wording that described steps this system does not take: "routed for GL coding"
-- (there is no coding screen), "netted against an open or future invoice" and "partial payment"
-- (credits and part-payments are not applied), "near-duplicate (embedding similarity)" (the
-- duplicate rule is same vendor + invoice number), and a tax rule "for the jurisdiction" (it
-- compares a line with its own tax code). The new text says what the engine actually checks, and
-- matches db/migrate-lib.ts, which builds fresh schemas.
-- Updates text in a lookup table only; codes are unchanged, so every recorded decision still points
-- at its code. Safe to re-run.
UPDATE reason_codes SET description = 'Three-way match within tolerance: no exception was found.'
  WHERE code = 'CLEAN_MATCH';
UPDATE reason_codes SET description = 'Same vendor and invoice number as an invoice already on file.'
  WHERE code = 'EXC-DUPLICATE';
UPDATE reason_codes SET description = 'Invoice has no PO reference, so there is nothing to three-way match it against; a person decides it.'
  WHERE code = 'EXC-NON_PO';
UPDATE reason_codes SET name = 'Credit Memo', description = 'A credit memo larger than what is still open on the invoice it relates to.'
  WHERE code = 'EXC-CREDIT_MEMO';
UPDATE reason_codes SET name = 'Partial Shipment', description = 'Invoice covers less than the full PO, for example after a partial shipment.'
  WHERE code = 'EXC-PARTIAL';
UPDATE reason_codes SET description = 'Tax on a line does not match the rate of that line''s tax code.'
  WHERE code = 'EXC-TAX_VAR';
UPDATE reason_codes SET description = 'The rules found a clean match, but the Investigator recommended a stricter outcome, or wrote free text instead of one of the system''s routes. An AI opinion can only tighten a decision, never loosen it, so a person reviews this invoice.'
  WHERE code = 'INVESTIGATOR_HOLD';
