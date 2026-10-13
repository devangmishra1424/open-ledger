-- Auditor requests record who acted, and the demo data stops naming a real audit firm.
--  * created_by / closed_by / closed_at: who recorded a request, and who handed the evidence over and
--    when. Before, nothing recorded who closed a request; closing now also writes an audit_assemble
--    record onto each linked invoice's hash-chained trail (lib/audit/pbc.ts).
--  * A seeded requester was "PwC Lead Auditor (E. Vance)": a real firm's name on invented data.
-- Additive columns plus a one-row rename; safe to re-run.
ALTER TABLE pbc_requests ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE pbc_requests ADD COLUMN IF NOT EXISTS closed_by TEXT;
ALTER TABLE pbc_requests ADD COLUMN IF NOT EXISTS closed_at TEXT;
UPDATE pbc_requests SET owner_name = 'External Auditor (E. Vance)' WHERE owner_name = 'PwC Lead Auditor (E. Vance)';
