-- Settings guardrails (max auto-approval amount, minimum Investigator confidence) can now hold an
-- otherwise clean match for a person. That outcome needs a reason code to point at.
INSERT INTO reason_codes (code, name, description) VALUES (
  'POLICY_LIMIT', 'Auto-Approval Limit',
  'A clean match was held for a person because it exceeds the Settings amount limit or the Investigator''s confidence is below the Settings threshold.'
) ON CONFLICT (code) DO NOTHING;
