import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { coderSessionChapters208 } from '../208_coder_session_chapters.js';
import { CENTRAL_DROP_TABLES, CENTRAL_FTS_VTABS } from '../../project-db/trim/drop-list.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

function createLegacySchema(): void {
  db.exec(`
    CREATE TABLE coder_sessions (
      id INTEGER PRIMARY KEY,
      summary_boundary_id INTEGER,
      compaction_summary TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE coder_messages (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES coder_sessions(id) ON DELETE CASCADE
    );
  `);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});
afterEach(() => db.close());

describe('migration 208 — coder session chapters', () => {
  it('classifies the base and FTS tables as central for project-DB trimming', () => {
    expect(CENTRAL_DROP_TABLES).toContain('coder_session_chapters');
    expect(CENTRAL_FTS_VTABS).toContain('coder_session_chapters_fts');
  });

  it('is a no-op for a trimmed project database', () => {
    expect(() => coderSessionChapters208.up(db)).not.toThrow();
    const row = db.prepare(`
      SELECT 1 FROM sqlite_master WHERE name = 'coder_session_chapters'
    `).get();
    expect(row).toBeUndefined();
  });

  it('backfills one searchable legacy chapter without deleting messages', () => {
    createLegacySchema();
    db.prepare(`
      INSERT INTO coder_sessions (id, summary_boundary_id, compaction_summary)
      VALUES (1, 2, 'Decisão sobre autenticação e cache')
    `).run();
    db.prepare('INSERT INTO coder_messages (id, session_id) VALUES (1, 1), (2, 1), (3, 1)').run();

    coderSessionChapters208.up(db);

    const chapter = db.prepare('SELECT * FROM coder_session_chapters').get() as {
      ordinal: number;
      start_message_id: number;
      end_message_id: number;
      source: string;
      chapter_text: string;
      resume_text: string;
      version: number;
    };
    expect(chapter).toMatchObject({
      ordinal: 1,
      start_message_id: 1,
      end_message_id: 2,
      source: 'legacy',
      chapter_text: 'Decisão sobre autenticação e cache',
      resume_text: 'Decisão sobre autenticação e cache',
      version: 2,
    });
    expect((db.prepare('SELECT COUNT(*) AS count FROM coder_messages').get() as { count: number }).count).toBe(3);
    const hit = db.prepare(`
      SELECT c.id FROM coder_session_chapters_fts f
      JOIN coder_session_chapters c ON c.id = f.rowid
      WHERE coder_session_chapters_fts MATCH '"autenticacao"'
    `).get();
    expect(hit).toBeDefined();
  });

  it('is idempotent and cascades chapters plus their FTS row', () => {
    createLegacySchema();
    db.prepare(`
      INSERT INTO coder_sessions (id, summary_boundary_id, compaction_summary)
      VALUES (1, 1, 'Resumo legado')
    `).run();
    db.prepare('INSERT INTO coder_messages (id, session_id) VALUES (1, 1)').run();
    coderSessionChapters208.up(db);
    expect(() => coderSessionChapters208.up(db)).not.toThrow();
    expect((db.prepare('SELECT COUNT(*) AS count FROM coder_session_chapters').get() as { count: number }).count).toBe(1);

    db.prepare('DELETE FROM coder_sessions WHERE id = 1').run();
    expect((db.prepare('SELECT COUNT(*) AS count FROM coder_session_chapters').get() as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM coder_session_chapters_fts').get() as { count: number }).count).toBe(0);
  });
});
