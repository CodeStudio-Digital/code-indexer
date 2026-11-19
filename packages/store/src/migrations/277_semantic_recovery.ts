import type { Migration } from './types.js';

export const semanticRecovery277: Migration = {
  version: 277,
  name: 'semantic_recovery',
  scope: 'central',
  up(db) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_semantic_jobs_open_generations
      ON semantic_jobs(namespace, generation_id)
      WHERE kind IN ('build','backfill') AND status IN ('pending','running','paused')
        AND generation_id IS NOT NULL`);
    // Legacy databases can already contain many attempts. A trigger protects
    // new writes immediately while the maintenance worker prunes old copies.
    const managed = `NEW.namespace = 'memory:user' OR NEW.namespace GLOB 'memory:project:p[0-9]*'
      OR NEW.namespace GLOB 'snapshot:p[0-9]*' OR NEW.namespace GLOB 'docs:c[0-9]*'`;
    const open = "('pending','running','paused')";
    const guard = `NEW.kind IN ('build','backfill') AND NEW.generation_id IS NOT NULL
      AND NEW.status IN ${open} AND (${managed})
      AND EXISTS (SELECT 1 FROM semantic_jobs j WHERE j.namespace = NEW.namespace
        AND j.generation_id = NEW.generation_id AND j.kind = NEW.kind AND j.status IN ${open})`;
    db.exec(`CREATE TRIGGER IF NOT EXISTS semantic_build_insert_once BEFORE INSERT ON semantic_jobs
      WHEN ${guard} BEGIN SELECT RAISE(ABORT, 'semantic build already open'); END;
      CREATE TRIGGER IF NOT EXISTS semantic_build_reopen_once BEFORE UPDATE OF status, namespace, generation_id, kind ON semantic_jobs
      WHEN (OLD.status NOT IN ${open} OR OLD.namespace IS NOT NEW.namespace OR OLD.kind IS NOT NEW.kind
        OR OLD.generation_id IS NOT NEW.generation_id) AND ${guard}
      BEGIN SELECT RAISE(ABORT, 'semantic build already open'); END;`);
  },
};
