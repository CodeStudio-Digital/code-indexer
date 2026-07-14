import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { coderSessionChapters208 } from '@mcp/store/migrations/208_coder_session_chapters.js';
import { coderCompactionReliability217 } from '@mcp/store/migrations/217_coder_compaction_reliability.js';
import * as chapters from '../chapters.js';

let db: DB;

function createSchema(): void {
  db.exec(`
    CREATE TABLE coder_sessions (
      id INTEGER PRIMARY KEY,
      summary_boundary_id INTEGER,
      compaction_summary TEXT,
      last_response_id TEXT,
      last_response_message_count INTEGER,
      compaction_count_auto INTEGER NOT NULL DEFAULT 0,
      compaction_count_manual INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE coder_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES coder_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content_json TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      is_meta INTEGER NOT NULL DEFAULT 0,
      selected_skill_ids_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO coder_sessions (id) VALUES (1), (2);
  `);
  coderSessionChapters208.up(db);
  coderCompactionReliability217.up(db);
}

function append(sessionId: number, text: string, role = 'user'): number {
  const result = db.prepare(`
    INSERT INTO coder_messages (session_id, role, content_json)
    VALUES (?, ?, ?)
  `).run(sessionId, role, JSON.stringify([{ type: 'text', text }]));
  return Number(result.lastInsertRowid);
}

function input(
  sessionId: number,
  expectedBoundaryId: number,
  startMessageId: number,
  endMessageId: number,
  label: string,
  source: 'auto' | 'manual' = 'auto',
) {
  return {
    sessionId,
    expectedBoundaryId,
    startMessageId,
    endMessageId,
    source,
    trigger: 'context_threshold',
    title: `Capítulo ${label}`,
    chapterJson: `{"label":"${label}"}`,
    chapterText: `Resumo pesquisável ${label}`,
    resumeJson: `{"focus":"${label}"}`,
    resumeText: `Retomar ${label}`,
    version: 3,
    metricsJson: `{"input":${endMessageId - startMessageId + 1}}`,
  } as const;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createSchema();
});
afterEach(() => db.close());

describe('conversation chapter store', () => {
  it('keeps ten immutable chapters and paginates/searches their source', () => {
    const persistedJson: string[] = [];
    let boundary = 0;
    for (let i = 1; i <= 10; i++) {
      const messageId = append(1, `mensagem ${i}`);
      const payload = input(1, boundary, messageId, messageId, i === 1 ? 'primeiro marco' : `marco ${i}`);
      const result = chapters.commit(db, payload);
      expect(result.status).toBe('committed');
      persistedJson.push(payload.chapterJson);
      boundary = messageId;
    }

    expect(chapters.count(db, 1)).toBe(10);
    const firstPage = chapters.list(db, 1, { limit: 3 });
    expect(firstPage.items.map((row) => row.ordinal)).toEqual([10, 9, 8]);
    expect(firstPage.next_cursor).toBe('chapter:8');
    const secondPage = chapters.list(db, 1, { limit: 3, cursor: firstPage.next_cursor });
    expect(secondPage.items.map((row) => row.ordinal)).toEqual([7, 6, 5]);

    const hit = chapters.search(db, 1, 'primeiro marco');
    expect(hit.items).toHaveLength(1);
    expect(hit.items[0].ordinal).toBe(1);
    const source = chapters.listSource(db, 1, hit.items[0].id, { limit: 1 });
    expect(source.items).toHaveLength(1);
    expect(source.items[0].id).toBe(hit.items[0].start_message_id);

    const rows = db.prepare(`
      SELECT chapter_json FROM coder_session_chapters
      WHERE session_id = 1 ORDER BY ordinal
    `).all() as Array<{ chapter_json: string }>;
    expect(rows.map((row) => row.chapter_json)).toEqual(persistedJson);
    expect((db.prepare('SELECT COUNT(*) AS count FROM coder_messages WHERE session_id = 1').get() as { count: number }).count).toBe(10);
  });

  it('uses compare-and-set monotonicity and rolls back the insert if boundary persistence fails', () => {
    const first = append(1, 'first');
    const committed = chapters.commit(db, input(1, 0, first, first, 'one'));
    expect(committed.status).toBe('committed');
    const repeated = chapters.commit(db, input(1, 0, first, first, 'one'));
    expect(repeated).toMatchObject({ status: 'noop', reason: 'already_committed' });

    const second = append(1, 'second');
    const stale = chapters.commit(db, input(1, 0, second, second, 'two'));
    expect(stale).toMatchObject({ status: 'noop', reason: 'boundary_changed' });

    db.exec(`
      CREATE TRIGGER reject_chapter_boundary
      BEFORE UPDATE OF summary_boundary_id ON coder_sessions
      WHEN new.summary_boundary_id = ${second}
      BEGIN SELECT RAISE(ABORT, 'forced boundary failure'); END;
    `);
    expect(() => chapters.commit(db, input(1, first, second, second, 'two')))
      .toThrow(/forced boundary failure/);
    expect(chapters.count(db, 1)).toBe(1);
    expect((db.prepare('SELECT summary_boundary_id AS id FROM coder_sessions WHERE id = 1').get() as { id: number }).id).toBe(first);
  });

  it('appends a manual chapter after an automatic one without overlap or counter regression', () => {
    const first = append(1, 'automatic span');
    expect(chapters.commit(db, input(1, 0, first, first, 'auto'))).toMatchObject({ status: 'committed' });
    const second = append(1, 'manual span');
    expect(chapters.commit(db, input(1, first, second, second, 'manual', 'manual')))
      .toMatchObject({ status: 'committed' });
    const rows = chapters.list(db, 1).items;
    expect(rows.map((row) => row.source)).toEqual(['manual', 'auto']);
    const counters = db.prepare(`
      SELECT summary_boundary_id, compaction_count_auto, compaction_count_manual
      FROM coder_sessions WHERE id = 1
    `).get() as { summary_boundary_id: number; compaction_count_auto: number; compaction_count_manual: number };
    expect(counters).toEqual({
      summary_boundary_id: second,
      compaction_count_auto: 1,
      compaction_count_manual: 1,
    });
  });

  it('rebuilds legacy history atomically without moving the current resume', () => {
    const ids = [append(1, 'a'), append(1, 'b'), append(1, 'c'), append(1, 'd')];
    db.prepare(`
      UPDATE coder_sessions SET summary_boundary_id = ?, compaction_summary = 'resume vivo'
      WHERE id = 1
    `).run(ids[3]);
    db.prepare(`
      INSERT INTO coder_session_chapters (
        session_id, ordinal, start_message_id, end_message_id, source, trigger,
        title, chapter_json, chapter_text, resume_json, resume_text, version
      ) VALUES (1, 1, ?, ?, 'legacy', 'migration', 'Legado', '{}', 'legado', '{}', 'resume vivo', 2)
    `).run(ids[0], ids[3]);

    const result = chapters.insertRebuilt(db, 1, [
      { ...input(1, 0, ids[0], ids[1], 'parte um'), startMessageId: ids[0], endMessageId: ids[1] },
      { ...input(1, 0, ids[2], ids[3], 'parte dois'), startMessageId: ids[2], endMessageId: ids[3] },
    ]);
    expect(result.superseded_count).toBe(1);
    expect(result.items.map((row) => row.source)).toEqual(['rebuild', 'rebuild']);
    expect(chapters.count(db, 1)).toBe(2);
    expect(chapters.count(db, 1, true)).toBe(3);
    const session = db.prepare(`
      SELECT summary_boundary_id, compaction_summary FROM coder_sessions WHERE id = 1
    `).get() as { summary_boundary_id: number; compaction_summary: string };
    expect(session).toEqual({ summary_boundary_id: ids[3], compaction_summary: 'resume vivo' });
    const retry = chapters.insertRebuilt(db, 1, [
      { ...input(1, 0, ids[0], ids[1], 'parte um'), startMessageId: ids[0], endMessageId: ids[1] },
      { ...input(1, 0, ids[2], ids[3], 'parte dois'), startMessageId: ids[2], endMessageId: ids[3] },
    ]);
    expect(retry).toMatchObject({ superseded_count: 0 });
    expect(retry.items).toHaveLength(2);
  });

  it('copies mapped chapters and restores the previous resume on rollback', () => {
    const sourceIds = [append(1, 'one'), append(1, 'two')];
    chapters.commit(db, input(1, 0, sourceIds[0], sourceIds[0], 'one'));
    chapters.commit(db, input(1, sourceIds[0], sourceIds[1], sourceIds[1], 'two'));
    const targetIds = [append(2, 'one'), append(2, 'two')];
    const idMap = new Map([
      [sourceIds[0], targetIds[0]],
      [sourceIds[1], targetIds[1]],
    ]);

    expect(chapters.copy(db, 1, 2, idMap)).toBe(2);
    expect(chapters.count(db, 2)).toBe(2);
    let target = db.prepare(`
      SELECT summary_boundary_id, compaction_summary FROM coder_sessions WHERE id = 2
    `).get() as { summary_boundary_id: number; compaction_summary: string };
    expect(target).toEqual({ summary_boundary_id: targetIds[1], compaction_summary: 'Retomar two' });

    expect(chapters.rollback(db, 2, targetIds[1])).toBe(1);
    target = db.prepare(`
      SELECT summary_boundary_id, compaction_summary FROM coder_sessions WHERE id = 2
    `).get() as { summary_boundary_id: number; compaction_summary: string };
    expect(target).toEqual({ summary_boundary_id: targetIds[0], compaction_summary: 'Retomar one' });
  });
});
