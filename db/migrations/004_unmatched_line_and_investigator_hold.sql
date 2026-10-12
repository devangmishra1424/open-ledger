-- Two outcomes the engine can now produce, each needing a reason code to point at:
--  * EXC-UNMATCHED_LINE: an invoice line that matches no line on the PO (an extra fee, an item
--    nobody ordered). Before, such a line was only counted, and the invoice could auto-approve.
--  * INVESTIGATOR_HOLD: the rules found a clean match, but the Investigator recommended a stricter
--    outcome. The AI can only tighten a decision, so a person reviews it.
-- Additive only (two rows in a lookup table); safe to re-run.
INSERT INTO reason_codes (code, name, description) VALUES (
  'EXC-UNMATCHED_LINE', 'Line Not on Purchase Order',
  'One or more invoice lines match no line on the referenced purchase order, for example an added fee or an item that was never ordered.'
) ON CONFLICT (code) DO NOTHING;
INSERT INTO reason_codes (code, name, description) VALUES (
  'INVESTIGATOR_HOLD', 'Held by AI Reviewer',
  'The rules found a clean match, but the Investigator recommended a stricter outcome. An AI opinion can only tighten a decision, never loosen it, so a person reviews this invoice.'
) ON CONFLICT (code) DO NOTHING;
