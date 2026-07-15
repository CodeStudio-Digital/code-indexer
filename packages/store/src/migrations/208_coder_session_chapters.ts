/**
 * Migration 208 — append-only conversation chapters.
 *
 * Durable compaction previously kept only the latest rendered resume on
 * `coder_sessions`.  Chapters retain every compacted span while the raw
 * `coder_messages` rows remain untouched.  This is a CENTRAL-only table:
 * project databases run the same migration lineage after `coder_sessions` has
 * been trimmed, so the whole migration must be guarded.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
}

export const coderSessionChapters208: Migration = {
  version: 208,
  name: 'coder_session_chapters',
  up(db: DB): void {
    // `coder_sessions` is central and is absent after project-DB trimming.
    if (!tableExists(db, 'coder_sessions')) return;

    db.exec(`
      CREATE TABLE IF NOT EXISTS coder_session_chapters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES coder_sessions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        start_message_id INTEGER NOT NULL CHECK (start_message_id > 0),
        end_message_id INTEGER NOT NULL CHECK (end_message_id >= start_message_id),
        source TEXT NOT NULL CHECK (source IN ('auto', 'manual', 'legacy', 'rebuild', 'import')),
        trigger TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        chapter_json TEXT NOT NULL,
        chapter_text TEXT NOT NULL,
        resume_json TEXT NOT NULL,
        resume_text TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 3 CHECK (version > 0),
        metrics_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        superseded_at TEXT,
        UNIQUE(session_id, ordinal)
      );

      CREATE INDEX IF NOT EXISTS idx_coder_session_chapters_session_created
        ON coder_session_chapters(session_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_coder_session_chapters_session_span
        ON coder_session_chapters(session_id, start_message_id, end_message_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_coder_session_chapters_live_end
        ON coder_session_chapters(session_id, end_message_id)
        WHERE superseded_at IS NULL;

      CREATE VIRTUAL TABLE IF NOT EXISTS coder_session_chapters_fts USING fts5(
        session_id UNINDEXED,
        title,
        chapter_text,
        resume_text,
        content='coder_session_chapters',
        content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS coder_session_chapters_ai
      AFTER INSERT ON coder_session_chapters BEGIN
        INSERT INTO coder_session_chapters_fts(
          rowid, session_id, title, chapter_text, resume_text
        ) VALUES (
          new.id, new.session_id, new.title, new.chapter_text, new.resume_text
        );
      END;

      CREATE TRIGGER IF NOT EXISTS coder_session_chapters_ad
      AFTER DELETE ON coder_session_chapters BEGIN
        INSERT INTO coder_session_chapters_fts(
          coder_session_chapters_fts,
          rowid, session_id, title, chapter_text, resume_text
        ) VALUES (
          'delete', old.id, old.session_id, old.title, old.chapter_text, old.resume_text
        );
      END;

      CREATE TRIGGER IF NOT EXISTS coder_session_chapters_au
      AFTER UPDATE OF session_id, title, chapter_text, resume_text
      ON coder_session_chapters BEGIN
        INSERT INTO coder_session_chapters_fts(
          coder_session_chapters_fts,
          rowid, session_id, title, chapter_text, resume_text
        ) VALUES (
          'delete', old.id, old.session_id, old.title, old.chapter_text, old.resume_text
        );
        INSERT INTO coder_session_chapters_fts(
          rowid, session_id, title, chapter_text, resume_text
        ) VALUES (
          new.id, new.session_id, new.title, new.chapter_text, new.resume_text
        );
      END;
    `);

    // Preserve the latest pre-V3 resume as one legacy chapter.  No model call
    // happens during migration and the original transcript remains intact.
    db.exec(`
      INSERT OR IGNORE INTO coder_session_chapters (
        session_id, ordinal, start_message_id, end_message_id,
        source, trigger, title,
        chapter_json, chapter_text, resume_json, resume_text,
        version, metrics_json, created_at
      )
      SELECT
        s.id,
        1,
        COALESCE((
          SELECT MIN(m.id)
          FROM coder_messages m
          WHERE m.session_id = s.id AND m.id <= s.summary_boundary_id
        ), s.summary_boundary_id),
        s.summary_boundary_id,
        'legacy',
        'migration_208',
        'Resumo anterior',
        '{}',
        s.compaction_summary,
        '{}',
        s.compaction_summary,
        2,
        '{"backfilled":true}',
        COALESCE(s.updated_at, datetime('now'))
      FROM coder_sessions s
      WHERE s.summary_boundary_id IS NOT NULL
        AND s.summary_boundary_id > 0
        AND TRIM(COALESCE(s.compaction_summary, '')) <> '';
    `);

    // Also repairs an interrupted/manual invocation where base rows existed
    // before the FTS triggers were installed. Safe and idempotent for FTS5.
    db.exec(`
      INSERT INTO coder_session_chapters_fts(coder_session_chapters_fts)
      VALUES ('rebuild');
    `);
  },
};
