/**
 * Migration 232 — remove the retired per-file LLM analysis schema.
 *
 * Code semantics now come from source-derived candidates plus the central
 * semantic generation/item ledger. Keeping summaries, concepts, artificial
 * layers/complexity, per-row embedding hashes, run snapshots and LLM run
 * telemetry created a second, stale source of truth. Documentation enrichment
 * and the session/coder snapshot tables are intentionally outside this migration.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, name: string): boolean {
  return !!db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?`,
  ).get(name);
}

function columns(db: DB, table: string): Set<string> {
  if (!tableExists(db, table)) return new Set();
  return new Set((db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
    .map((column) => column.name));
}

function dropColumnIfPresent(db: DB, table: string, column: string): void {
  if (!columns(db, table).has(column)) return;
  db.exec(`ALTER TABLE "${table}" DROP COLUMN "${column}"`);
}

function recreateFilesFts(db: DB): void {
  if (!tableExists(db, 'files')) return;
  db.exec(`
    CREATE VIRTUAL TABLE files_fts USING fts5(
      path, content='files', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER files_ai AFTER INSERT ON files BEGIN
      INSERT INTO files_fts(rowid, path) VALUES (new.id, new.path);
    END;

    CREATE TRIGGER files_ad AFTER DELETE ON files BEGIN
      INSERT INTO files_fts(files_fts, rowid, path)
      VALUES ('delete', old.id, old.path);
    END;
  `);
  db.exec(`INSERT INTO files_fts(files_fts) VALUES('rebuild')`);
}

export const removeCodeLlmIndex232: Migration = {
  version: 232,
  name: 'remove_code_llm_index',
  up(db: DB): void {
    // The old FTS schema references files.summary/concepts and must disappear
    // before SQLite permits those columns to be dropped.
    for (const trigger of ['files_ai', 'files_ad', 'files_au']) {
      db.exec(`DROP TRIGGER IF EXISTS "${trigger}"`);
    }
    db.exec('DROP TABLE IF EXISTS files_fts');

    for (const index of [
      'idx_files_project_embedding',
      'idx_files_semantic',
    ]) {
      db.exec(`DROP INDEX IF EXISTS "${index}"`);
    }

    for (const column of [
      'summary',
      'concepts',
      'notes',
      'complexity',
      'layer',
      'embedding_hash',
      'structure_hash',
      'structure_embedding',
      'semantic_hash',
    ]) {
      dropColumnIfPresent(db, 'files', column);
    }

    // Completion hashes on symbols belonged to the same retired ledger.
    dropColumnIfPresent(db, 'symbols', 'embedding_hash');
    dropColumnIfPresent(db, 'symbols', 'body_embedding_hash');

    db.exec('DROP TABLE IF EXISTS file_concepts');
    db.exec('DROP TABLE IF EXISTS file_snapshots');

    // `runs` now records only structural reconciliations. Semantic progress and
    // model provenance have dedicated generations/jobs tables, so the old full
    // LLM runs and their provider/token telemetry are neither written nor read.
    const runColumns = columns(db, 'runs');
    if (runColumns.has('kind')) {
      db.exec(`DELETE FROM runs WHERE kind IS NULL OR kind <> 'structural'`);
    }
    for (const column of [
      'provider',
      'model',
      'input_tokens',
      'output_tokens',
      'embedding_tokens',
      'estimated_cost_usd',
      'phase_timings_json',
      'peak_rss_mb',
      'kind',
    ]) {
      dropColumnIfPresent(db, 'runs', column);
    }

    recreateFilesFts(db);
  },
};
