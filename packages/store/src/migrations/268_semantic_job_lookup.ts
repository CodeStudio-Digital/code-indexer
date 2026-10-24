import type { Migration } from './types.js';

export const semanticJobLookup268: Migration = {
  version: 268,
  name: 'semantic_job_lookup',
  up(db) {
    // Project databases share the migration lineage but deliberately trim this
    // central-only table. Upgrading an existing project must remain a no-op.
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='semantic_jobs'").get()) return;
    db.exec(`CREATE INDEX IF NOT EXISTS idx_semantic_jobs_namespace_kind_status
      ON semantic_jobs(namespace, kind, status, id DESC)`);
  },
};
