/** Migration 225 — one-way Claude Code/Codex session snapshot identity. */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const externalSessionImports225: Migration = {
  version: 225,
  name: 'external_session_imports',
  outsideTransaction: true,
  up(db: DB): void {
    const table = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coder_sessions'`,
    ).get();
    if (!table) return;

    const foreignKeys = Number((db.pragma('foreign_keys', { simple: true }) as number) ?? 0);
    db.pragma('foreign_keys = OFF');
    db.pragma('legacy_alter_table = ON');
    const tx = db.transaction(() => {
      const columns = db.prepare(`PRAGMA table_info(coder_sessions)`).all() as Array<{ name: string }>;
      const has = (name: string): boolean => columns.some((column) => column.name === name);
      const additions: Array<[string, string]> = [
        ['import_source', 'TEXT'],
        ['import_external_id', 'TEXT'],
        ['import_fingerprint', 'TEXT'],
        ['import_source_updated_at', 'TEXT'],
        ['import_metadata_json', 'TEXT'],
        ['imported_at', 'TEXT'],
      ];
      for (const [name, type] of additions) {
        if (!has(name)) db.exec(`ALTER TABLE coder_sessions ADD COLUMN ${name} ${type}`);
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_coder_sessions_external_identity
        ON coder_sessions(project_id, import_source, import_external_id)
        WHERE import_source IS NOT NULL AND import_external_id IS NOT NULL;
      `);

      const chapterSql = (db.prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'coder_session_chapters'`,
      ).get() as { sql: string } | undefined)?.sql ?? '';
      if (chapterSql && !chapterSql.includes("'import'")) rebuildChapterTable(db);
    });
    try { tx(); } finally {
      db.pragma('legacy_alter_table = OFF');
      if (foreignKeys) db.pragma('foreign_keys = ON');
    }
  },
};

function rebuildChapterTable(db: DB): void {
  db.exec(`
    ALTER TABLE coder_session_chapters RENAME TO coder_session_chapters_legacy_225;
    CREATE TABLE coder_session_chapters (
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
      chapter_kind TEXT NOT NULL DEFAULT 'context' CHECK (chapter_kind IN ('context', 'milestone', 'rebuild')),
      advances_context_boundary INTEGER NOT NULL DEFAULT 1 CHECK (advances_context_boundary IN (0, 1)),
      UNIQUE(session_id, ordinal)
    );
    INSERT INTO coder_session_chapters SELECT * FROM coder_session_chapters_legacy_225;
    DROP TABLE coder_session_chapters_legacy_225;

    CREATE INDEX idx_coder_session_chapters_session_created
      ON coder_session_chapters(session_id, created_at DESC, id DESC);
    CREATE INDEX idx_coder_session_chapters_session_span
      ON coder_session_chapters(session_id, start_message_id, end_message_id);
    CREATE UNIQUE INDEX idx_coder_session_chapters_live_context_end
      ON coder_session_chapters(session_id, end_message_id)
      WHERE superseded_at IS NULL AND advances_context_boundary = 1;

    CREATE TRIGGER coder_session_chapters_ai AFTER INSERT ON coder_session_chapters BEGIN
      INSERT INTO coder_session_chapters_fts(rowid, session_id, title, chapter_text, resume_text)
      VALUES (new.id, new.session_id, new.title, new.chapter_text, new.resume_text);
    END;
    CREATE TRIGGER coder_session_chapters_ad AFTER DELETE ON coder_session_chapters BEGIN
      INSERT INTO coder_session_chapters_fts(coder_session_chapters_fts, rowid, session_id, title, chapter_text, resume_text)
      VALUES ('delete', old.id, old.session_id, old.title, old.chapter_text, old.resume_text);
    END;
    CREATE TRIGGER coder_session_chapters_au
    AFTER UPDATE OF session_id, title, chapter_text, resume_text ON coder_session_chapters BEGIN
      INSERT INTO coder_session_chapters_fts(coder_session_chapters_fts, rowid, session_id, title, chapter_text, resume_text)
      VALUES ('delete', old.id, old.session_id, old.title, old.chapter_text, old.resume_text);
      INSERT INTO coder_session_chapters_fts(rowid, session_id, title, chapter_text, resume_text)
      VALUES (new.id, new.session_id, new.title, new.chapter_text, new.resume_text);
    END;
    INSERT INTO coder_session_chapters_fts(coder_session_chapters_fts) VALUES ('rebuild');
  `);
}
