/**
 * Migration 217 — durable compaction attempts + chapter classification.
 *
 * Compaction used to be observable only through two optimistic booleans on
 * coder_turn_telemetry.  The BT runner writes that row before it decides to
 * compact, so production sessions could mechanically drop history while the
 * dashboard permanently reported zero attempts.  Keep an append/update audit
 * row for every attempt and separate navigational rebuild chapters from
 * checkpoints that actually advance the model context boundary.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function columnExists(db: DB, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some((row) => row.name === column);
}

export const coderCompactionReliability217: Migration = {
  version: 217,
  name: 'coder_compaction_reliability',
  up(db: DB): void {
    // coder_sessions is central-only and is absent from trimmed project DBs.
    if (!tableExists(db, 'coder_sessions')) return;

    if (tableExists(db, 'coder_session_chapters')) {
      if (!columnExists(db, 'coder_session_chapters', 'chapter_kind')) {
        db.exec("ALTER TABLE coder_session_chapters ADD COLUMN chapter_kind TEXT NOT NULL DEFAULT 'context' CHECK (chapter_kind IN ('context', 'milestone', 'rebuild'))");
      }
      if (!columnExists(db, 'coder_session_chapters', 'advances_context_boundary')) {
        db.exec('ALTER TABLE coder_session_chapters ADD COLUMN advances_context_boundary INTEGER NOT NULL DEFAULT 1 CHECK (advances_context_boundary IN (0, 1))');
      }

      db.exec(`
        UPDATE coder_session_chapters
        SET chapter_kind = 'rebuild', advances_context_boundary = 0
        WHERE source = 'rebuild';

        UPDATE coder_session_chapters
        SET chapter_kind = 'milestone'
        WHERE trigger LIKE 'milestone:%';

        DROP INDEX IF EXISTS idx_coder_session_chapters_live_end;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_coder_session_chapters_live_context_end
          ON coder_session_chapters(session_id, end_message_id)
          WHERE superseded_at IS NULL AND advances_context_boundary = 1;
      `);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS coder_compaction_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES coder_sessions(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        turn INTEGER NOT NULL DEFAULT 0,
        turn_telemetry_id INTEGER REFERENCES coder_turn_telemetry(id) ON DELETE SET NULL,
        trigger TEXT NOT NULL DEFAULT '',
        provider_chain_json TEXT NOT NULL DEFAULT '[]',
        summary_provider TEXT,
        summary_model TEXT,
        status TEXT NOT NULL DEFAULT 'started'
          CHECK (status IN ('started', 'summarized', 'deterministic_fallback', 'noop', 'checkpoint_failed')),
        strategy TEXT NOT NULL DEFAULT 'none'
          CHECK (strategy IN ('none', 'summarizer', 'deterministic')),
        summarizer_ran INTEGER NOT NULL DEFAULT 0 CHECK (summarizer_ran IN (0, 1)),
        prompt_tokens_before INTEGER,
        history_chars_before INTEGER,
        history_chars_after INTEGER,
        pruned_messages INTEGER NOT NULL DEFAULT 0,
        chapter_id INTEGER REFERENCES coder_session_chapters(id) ON DELETE SET NULL,
        boundary_id INTEGER,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_coder_compaction_attempts_session_created
        ON coder_compaction_attempts(session_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_coder_compaction_attempts_run_turn
        ON coder_compaction_attempts(run_id, turn, id);
    `);
  },
};
