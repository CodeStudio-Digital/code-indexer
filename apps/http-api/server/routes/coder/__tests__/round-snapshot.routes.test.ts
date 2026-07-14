import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { coderRoundFileSnapshots222 } from '@mcp/store/migrations/222_coder_round_file_snapshots.js';
import { SessionFileSnapshotStore } from '@mcp/store/session-file-snapshot-store.js';
import { mountCoderSnapshotRoutes } from '../snapshot.js';
import type { ServerDeps } from '../../../deps.js';

const databases: Database.Database[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

function setup() {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(`
    CREATE TABLE coder_messages (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      is_meta INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE session_file_baselines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_kind TEXT NOT NULL,
      session_id INTEGER NOT NULL,
      project_id INTEGER,
      file_path TEXT NOT NULL,
      content_before TEXT,
      rollback_content TEXT,
      existed_before INTEGER NOT NULL,
      baseline_hash TEXT NOT NULL,
      oversized INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      first_seen_at TEXT NOT NULL,
      last_edited_at TEXT NOT NULL,
      closed_at TEXT
    );
  `);
  coderRoundFileSnapshots222.up(db);
  db.prepare(
    "INSERT INTO coder_messages (id, session_id, role, is_meta) VALUES (11, 1, 'user', 0)",
  ).run();
  const store = new SessionFileSnapshotStore(db);
  const app = new Hono();
  mountCoderSnapshotRoutes(app, {
    sessionStore: {
      getDb: () => db,
      getSession: (id: number) => ({ id, project_id: 10 }),
    },
    db: {
      getProject: () => ({ root_path: 'C:\\repo' }),
    },
  } as unknown as ServerDeps);
  return { app, db, store };
}

function insertBaseline(
  db: Database.Database,
  input: { sessionId: number; projectId: number; filePath: string },
): number {
  const result = db.prepare(`
    INSERT INTO session_file_baselines
      (session_kind, session_id, project_id, file_path, content_before, rollback_content,
       existed_before, baseline_hash, oversized, status, first_seen_at, last_edited_at)
    VALUES ('coder', ?, ?, ?, 'before\n', 'before\n', 1, 'hash', 0, 'active',
            datetime('now'), datetime('now'))
  `).run(input.sessionId, input.projectId, input.filePath);
  return Number(result.lastInsertRowid);
}

describe('coder per-round snapshot routes', () => {
  it('lists a frozen round only when the user message and global baseline share its context', async () => {
    const { app, db, store } = setup();
    const baselineId = insertBaseline(db, { sessionId: 1, projectId: 10, filePath: 'a.ts' });
    store.recordRoundSnapshotMutation({
      session_kind: 'coder',
      session_id: 1,
      round_message_id: 11,
      global_baseline_id: baselineId,
      project_id: 10,
      file_path: 'a.ts',
      content_before: 'before\n',
      existed_before: true,
      content_after: 'after\n',
      existed_after: true,
      oversized: false,
    });

    const response = await app.request('/api/coder/sessions/1/snapshot/round/11');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      roundMessageId: 11,
      files: [expect.objectContaining({
        filePath: 'a.ts',
        globalBaselineId: baselineId,
        addedLines: 1,
        removedLines: 1,
      })],
    });
  });

  it('rejects a round snapshot linked to a baseline from another session', async () => {
    const { app, db, store } = setup();
    const foreignBaselineId = insertBaseline(db, {
      sessionId: 2,
      projectId: 10,
      filePath: 'a.ts',
    });
    store.recordRoundSnapshotMutation({
      session_kind: 'coder',
      session_id: 1,
      round_message_id: 11,
      global_baseline_id: foreignBaselineId,
      project_id: 10,
      file_path: 'a.ts',
      content_before: 'before\n',
      existed_before: true,
      content_after: 'after\n',
      existed_after: true,
      oversized: false,
    });

    const response = await app.request('/api/coder/sessions/1/snapshot/round/11');

    expect(response.status).toBe(404);
  });
});
