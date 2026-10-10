-- Human approvals, rejections and contests become entries in the decisions hash chain.
-- Adds 'human_review' to the allowed decisions.node_id values. Additive: no row changes,
-- no hash changes (node_id is just one more allowed string).
ALTER TABLE decisions DROP CONSTRAINT IF EXISTS decisions_node_id_check;
ALTER TABLE decisions ADD CONSTRAINT decisions_node_id_check
  CHECK (node_id IN ('extract','validate','match','investigate','verify','policy','audit','audit_assemble','human_review'));
