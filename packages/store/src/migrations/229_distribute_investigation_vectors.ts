/**
 * Migration 229 — investigation vectors move out of the central database.
 *
 * The relational text/metadata ledger remains central and is the rebuild
 * source. Historical embedding BLOBs/fingerprints are deliberately discarded:
 * semantic_items plus each project's vectors.db are backfilled from source
 * under the active Knowledge profile, never copied across vector spaces.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(table);
}

export const distributeInvestigationVectors229: Migration = {
  version: 229,
  name: 'distribute_investigation_vectors',
  up: (db: DB): void => {
    // coder_investigations is central-only and absent from trimmed project DBs.
    if (!tableExists(db, 'coder_investigations')) return;
    db.exec(`
      CREATE TABLE coder_investigations_v229 (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id    INTEGER,
        session_id    INTEGER,
        topic         TEXT NOT NULL,
        summary       TEXT NOT NULL,
        body          TEXT NOT NULL DEFAULT '',
        source_label  TEXT,
        agent_type    TEXT,
        tokens        INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO coder_investigations_v229
        (id, project_id, session_id, topic, summary, body,
         source_label, agent_type, tokens, created_at)
      SELECT id, project_id, session_id, topic, summary, body,
             source_label, agent_type, tokens, created_at
      FROM coder_investigations;

      DROP TABLE coder_investigations;
      ALTER TABLE coder_investigations_v229 RENAME TO coder_investigations;

      CREATE INDEX idx_coder_investigations_project
        ON coder_investigations(project_id, created_at DESC);
      CREATE INDEX idx_coder_investigations_session
        ON coder_investigations(session_id, created_at DESC);
    `);
  },
};
