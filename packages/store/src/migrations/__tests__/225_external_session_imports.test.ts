import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { externalSessionImports225 } from '../225_external_session_imports.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); });
afterEach(() => db.close());

describe('migration 225 — external session imports', () => {
  it('is a no-op for trimmed project databases', () => {
    expect(() => externalSessionImports225.up(db)).not.toThrow();
  });

  it('adds identity columns and enforces one import per project/source/id', () => {
    db.exec(`
      CREATE TABLE projects (id INTEGER PRIMARY KEY);
      CREATE TABLE coder_sessions (
        id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL
      );
      INSERT INTO projects VALUES (1), (2);
    `);
    externalSessionImports225.up(db);
    const columns = db.prepare(`PRAGMA table_info(coder_sessions)`).all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'import_source', 'import_external_id', 'import_fingerprint', 'imported_at',
    ]));
    const insert = db.prepare(`
      INSERT INTO coder_sessions (id, project_id, title, provider, model, import_source, import_external_id)
      VALUES (?, ?, 't', 'p', 'm', 'codex', 'external-1')
    `);
    insert.run(1, 1);
    expect(() => insert.run(2, 1)).toThrow(/UNIQUE/);
    expect(() => insert.run(3, 2)).not.toThrow();
  });

  it('extends an existing chapter source constraint without losing rows or foreign keys', () => {
    db.exec(`
      CREATE TABLE projects (id INTEGER PRIMARY KEY);
      CREATE TABLE coder_sessions (
        id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL
      );
      CREATE TABLE coder_session_chapters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES coder_sessions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal > 0), start_message_id INTEGER NOT NULL,
        end_message_id INTEGER NOT NULL, source TEXT NOT NULL CHECK (source IN ('auto','manual','legacy','rebuild')),
        trigger TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, chapter_json TEXT NOT NULL,
        chapter_text TEXT NOT NULL, resume_json TEXT NOT NULL, resume_text TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 3, metrics_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
        superseded_at TEXT, chapter_kind TEXT NOT NULL DEFAULT 'context',
        advances_context_boundary INTEGER NOT NULL DEFAULT 1, UNIQUE(session_id, ordinal)
      );
      CREATE VIRTUAL TABLE coder_session_chapters_fts USING fts5(
        session_id UNINDEXED, title, chapter_text, resume_text,
        content='coder_session_chapters', content_rowid='id'
      );
      CREATE TABLE coder_compaction_attempts (
        id INTEGER PRIMARY KEY, chapter_id INTEGER REFERENCES coder_session_chapters(id) ON DELETE SET NULL
      );
      INSERT INTO projects VALUES (1);
      INSERT INTO coder_sessions VALUES (1, 1, 't', 'p', 'm');
      INSERT INTO coder_session_chapters (
        id, session_id, ordinal, start_message_id, end_message_id, source, title,
        chapter_json, chapter_text, resume_json, resume_text
      ) VALUES (7, 1, 1, 1, 2, 'manual', 'old', '{}', 'old text', '{}', 'resume');
      INSERT INTO coder_compaction_attempts VALUES (1, 7);
    `);
    externalSessionImports225.up(db);
    expect((db.prepare(`SELECT title FROM coder_session_chapters WHERE id = 7`).get() as { title: string }).title).toBe('old');
    expect((db.prepare(`SELECT chapter_id FROM coder_compaction_attempts WHERE id = 1`).get() as { chapter_id: number }).chapter_id).toBe(7);
    expect(() => db.prepare(`
      INSERT INTO coder_session_chapters (
        session_id, ordinal, start_message_id, end_message_id, source, title,
        chapter_json, chapter_text, resume_json, resume_text
      ) VALUES (1, 2, 3, 4, 'import', 'new', '{}', 'new text', '{}', 'resume')
    `).run()).not.toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
