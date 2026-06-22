-- 0014_audit_org — org-scoped audit. Promote org_id to a column so org activity
-- (created, invites, role changes, billing, workspace pushes) is queryable per
-- organization — the Teams activity log + the foundation for Enterprise audit
-- export. ADD COLUMN is DDL, so the UPDATE/DELETE immutability triggers (0007)
-- don't block it. Existing rows keep org_id NULL (personal events).
ALTER TABLE audit_log ADD COLUMN org_id TEXT;
CREATE INDEX idx_audit_org ON audit_log(org_id, ts_ms);
