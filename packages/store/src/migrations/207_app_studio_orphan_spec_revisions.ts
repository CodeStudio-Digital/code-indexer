import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

/**
 * Proposals can be refined more than once before approval. Older revisions
 * that are no longer attached to a review evolution are history, not pending
 * work, and must not keep architecture blocked.
 */
export const appStudioOrphanSpecRevisions207: Migration = {
  version: 207,
  name: 'app_studio_orphan_spec_revisions',
  up(db: DB) {
    if (!tableExists(db, 'app_studio_spec_revisions') || !tableExists(db, 'app_studio_evolutions')) return;
    db.exec(`
      UPDATE app_studio_spec_revisions
      SET status = 'superseded'
      WHERE status = 'draft'
        AND NOT EXISTS (
          SELECT 1
          FROM app_studio_evolutions evolution
          WHERE evolution.proposed_revision_id = app_studio_spec_revisions.id
            AND evolution.status = 'review'
        );
    `);
  },
};
