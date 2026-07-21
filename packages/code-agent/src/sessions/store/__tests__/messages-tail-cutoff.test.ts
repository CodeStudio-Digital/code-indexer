/**
 * loadTail/loadBefore cutoff semantics after the mig-246 covering-index
 * rewrite (`role != 'tool'` → UNION ALL over the closed user/assistant set).
 * The returned window must stay byte-identical to the legacy predicate's for
 * tool-heavy transcripts, across boundaries and both fallback branches.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import * as messages from '../messages.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

/** One turn = user, assistant, tool, tool, assistant, tool (tool-heavy). */
const TURN: Array<'user' | 'assistant' | 'tool'> = [
  'user', 'assistant', 'tool', 'tool', 'assistant', 'tool',
];

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE coder_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER, title TEXT, provider TEXT, model TEXT,
      summary_boundary_id INTEGER,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE coder_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content_json TEXT NOT NULL,
      is_meta INTEGER DEFAULT 0
    );
  `);
  db.prepare(`INSERT INTO coder_sessions (project_id, title, provider, model) VALUES (1, 't', 'p', 'm')`).run();
  const ins = db.prepare(`INSERT INTO coder_messages (session_id, role, content_json) VALUES (1, ?, ?)`);
  for (let turn = 0; turn < 12; turn++) {
    for (const role of TURN) ins.run(role, JSON.stringify([{ type: 'text', text: `${role} ${turn}` }]));
  }
});

afterEach(() => db.close());

/** The pre-246 cutoff query — the semantic reference. */
function legacyCutoff(boundary: number, tail: number, beforeId?: number): number | undefined {
  const upper = beforeId === undefined ? '' : 'AND id < ? ';
  const params = beforeId === undefined ? [boundary] : [beforeId, boundary];
  const row = db.prepare(`
    SELECT id FROM coder_messages
     WHERE session_id = 1 ${upper}AND id > ? AND role != 'tool'
     ORDER BY id DESC LIMIT 1 OFFSET ?
  `).get(...params, Math.max(0, tail - 1)) as { id: number } | undefined;
  return row?.id;
}

function ids(rows: Array<{ id: number }>): number[] {
  return rows.map((r) => r.id);
}

describe('loadTail', () => {
  it('returns the same window as the legacy role != tool predicate', () => {
    for (const tail of [1, 2, 5, 8, 24]) {
      const cutoff = legacyCutoff(0, tail);
      expect(cutoff).toBeDefined();
      const expected = db.prepare(`
        SELECT id FROM coder_messages
         WHERE session_id = 1 AND id >= ? ORDER BY id LIMIT ?
      `).all(cutoff, tail * 5) as Array<{ id: number }>;
      const got = messages.loadTail(db, 1, tail)!;
      expect(ids(got.message_rows)).toEqual(ids(expected));
    }
  });

  it('keeps interleaved tool rows inside the returned window', () => {
    const got = messages.loadTail(db, 1, 4)!;
    const roles = new Set(got.message_rows.map((r) => r.role));
    expect(roles.has('tool')).toBe(true);
    expect(roles.has('user') || roles.has('assistant')).toBe(true);
  });

  it('falls back to the last tail*5 rows when fewer non-tool messages exist', () => {
    const tail = 999; // > 36 non-tool rows → no cutoff → fallback branch
    expect(legacyCutoff(0, tail)).toBeUndefined();
    const got = messages.loadTail(db, 1, tail)!;
    const total = (db.prepare('SELECT COUNT(*) AS c FROM coder_messages WHERE session_id = 1').get() as { c: number }).c;
    expect(got.message_rows.length).toBe(total); // tail*5 > total → everything
    expect(ids(got.message_rows)).toEqual([...ids(got.message_rows)].sort((a, b) => a - b));
  });

  it('respects the summary boundary', () => {
    const boundary = 30;
    db.prepare('UPDATE coder_sessions SET summary_boundary_id = ? WHERE id = 1').run(boundary);
    const tail = 3;
    const cutoff = legacyCutoff(boundary, tail)!;
    const got = messages.loadTail(db, 1, tail)!;
    expect(got.message_rows.every((r) => r.id > boundary)).toBe(true);
    expect(got.message_rows[0]!.id).toBe(cutoff);
  });
});

describe('loadBefore', () => {
  it('returns the same window as the legacy role != tool predicate', () => {
    for (const [beforeId, limit] of [[60, 4], [72, 10], [10, 2]] as const) {
      const cutoff = legacyCutoff(0, limit, beforeId);
      expect(cutoff).toBeDefined();
      const expected = db.prepare(`
        SELECT id FROM coder_messages
         WHERE session_id = 1 AND id >= ? AND id < ? ORDER BY id
      `).all(cutoff, beforeId) as Array<{ id: number }>;
      const got = messages.loadBefore(db, 1, beforeId, limit);
      expect(ids(got.message_rows)).toEqual(ids(expected));
    }
  });

  it('stops at the boundary and crosses it only with includeArchived', () => {
    const boundary = 36;
    db.prepare('UPDATE coder_sessions SET summary_boundary_id = ? WHERE id = 1').run(boundary);
    const beforeId = 45;

    const bounded = messages.loadBefore(db, 1, beforeId, 50);
    expect(bounded.message_rows.every((r) => r.id > boundary && r.id < beforeId)).toBe(true);

    const archived = messages.loadBefore(db, 1, beforeId, 50, true);
    expect(archived.message_rows.some((r) => r.id <= boundary)).toBe(true);
    expect(archived.message_rows.every((r) => r.id < beforeId)).toBe(true);
  });

  it('returns an empty window when nothing precedes beforeId', () => {
    const got = messages.loadBefore(db, 1, 1, 5);
    expect(got.message_rows).toEqual([]);
    expect(got.messages).toEqual([]);
  });
});
