/**
 * Session Drive store (migrations 125 `coder_session_memory` + 126
 * `coder_investigations`). Exercises the pure store functions against a
 * freshly-migrated in-memory SQLite: memory upsert/list/pin/delete,
 * investigation record/recall (project-scoped) + count, the derived file
 * map, and the aggregate + injection payload composition.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { coderSessions004 } from '@mcp/store/migrations/004_coder_sessions.js';
import { coderPlans007 } from '@mcp/store/migrations/007_coder_plans.js';
import { coderTasks008 } from '@mcp/store/migrations/008_coder_tasks.js';
import { coderSessionMemory125 } from '@mcp/store/migrations/125_coder_session_memory.js';
import { coderInvestigations126 } from '@mcp/store/migrations/126_coder_investigations.js';
import { investigationEmbedding127 } from '@mcp/store/migrations/127_investigation_embedding.js';
import { investigationEmbeddingFingerprint228 } from '@mcp/store/migrations/228_investigation_embedding_fingerprint.js';
import { distributeInvestigationVectors229 } from '@mcp/store/migrations/229_distribute_investigation_vectors.js';
import { SessionStore } from '../../store.js';
import * as drive from '../session-drive.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;
let s1: number; // project 1
let s2: number; // project 1 (shares investigations with s1)
let s3: number; // project 2

function mkSession(projectId: number): number {
  db.prepare(`INSERT INTO coder_sessions (project_id, title, provider, model) VALUES (?, 't', 'p', 'm')`).run(projectId);
  return Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(`CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, name TEXT)`);
  db.exec(`INSERT INTO projects (id, name) VALUES (1, 'one'), (2, 'two')`);
  coderSessions004.up(db);
  coderPlans007.up(db);
  coderTasks008.up(db);
  coderSessionMemory125.up(db);
  coderInvestigations126.up(db);
  investigationEmbedding127.up(db);
  investigationEmbeddingFingerprint228.up(db);
  distributeInvestigationVectors229.up(db);
  s1 = mkSession(1);
  s2 = mkSession(1);
  s3 = mkSession(2);
});

afterEach(() => db.close());

describe('session-drive memory', () => {
  it('remember inserts, then upserts by title (no duplicate)', () => {
    drive.remember(db, s1, { title: 'auth', body: 'v1' });
    drive.remember(db, s1, { title: 'auth', body: 'v2', kind: 'decision' });
    const rows = drive.listMemory(db, s1);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe('v2');
    expect(rows[0].kind).toBe('decision');
  });

  it('listMemory orders pinned first', () => {
    drive.remember(db, s1, { title: 'a', body: 'a' });
    drive.remember(db, s1, { title: 'b', body: 'b', pinned: true });
    const rows = drive.listMemory(db, s1);
    expect(rows[0].title).toBe('b');
    expect(rows[0].pinned).toBe(1);
  });

  it('setMemoryPinned + deleteMemory', () => {
    const m = drive.remember(db, s1, { title: 'x', body: 'x' });
    expect(drive.setMemoryPinned(db, s1, m.id, true)).toBe(true);
    expect(drive.listMemory(db, s1)[0].pinned).toBe(1);
    expect(drive.deleteMemory(db, s1, m.id)).toBe(true);
    expect(drive.listMemory(db, s1)).toHaveLength(0);
  });

  it('setMemoryPinned + deleteMemory are session-scoped (foreign id is a no-op)', () => {
    const m = drive.remember(db, s1, { title: 'x', body: 'x' });
    // s2 must not touch s1's note even with the right memory id.
    expect(drive.setMemoryPinned(db, s2, m.id, true)).toBe(false);
    expect(drive.listMemory(db, s1)[0].pinned).toBe(0);
    expect(drive.deleteMemory(db, s2, m.id)).toBe(false);
    expect(drive.listMemory(db, s1)).toHaveLength(1);
  });

  it('memory is session-scoped (not shared across sessions)', () => {
    drive.remember(db, s1, { title: 'x', body: 'x' });
    expect(drive.listMemory(db, s2)).toHaveLength(0);
  });

  it('memoryForInjection honours the limit, pinned first', () => {
    drive.remember(db, s1, { title: 'a', body: 'a' });
    drive.remember(db, s1, { title: 'b', body: 'b' });
    drive.remember(db, s1, { title: 'c', body: 'c', pinned: true });
    const out = drive.memoryForInjection(db, s1, 2);
    expect(out).toHaveLength(2);
    expect(out[0].title).toBe('c');
  });
});

describe('session-drive investigations', () => {
  it('records with project_id resolved from the session', () => {
    const row = drive.recordInvestigation(db, { session_id: s1, topic: 'auth flow', summary: 'lives in auth.ts' });
    expect(row.project_id).toBe(1);
    expect(row.session_id).toBe(s1);
  });

  it('recall keyword-matches topic/summary, project-scoped', () => {
    drive.recordInvestigation(db, { session_id: s1, topic: 'auth flow', summary: 'jwt in middleware' });
    // s2 is same project → sees s1's investigation.
    expect(drive.recallInvestigations(db, s2, 'auth')).toHaveLength(1);
    expect(drive.recallInvestigations(db, s2, 'jwt')).toHaveLength(1);
    expect(drive.recallInvestigations(db, s2, 'nonexistent')).toHaveLength(0);
    // s3 is a different project → does NOT see it.
    expect(drive.recallInvestigations(db, s3, 'auth')).toHaveLength(0);
  });

  it('countInvestigations is project-scoped', () => {
    drive.recordInvestigation(db, { session_id: s1, topic: 't', summary: 's' });
    expect(drive.countInvestigations(db, s2)).toBe(1);
    expect(drive.countInvestigations(db, s3)).toBe(0);
  });

  it('listInvestigations is session-scoped (panel mirrors the open session)', () => {
    drive.recordInvestigation(db, { session_id: s1, topic: 't', summary: 's' });
    expect(drive.listInvestigations(db, s1)).toHaveLength(1);
    // s2 shares the project (so it RECALLS s1's digest) but the panel list
    // must show only its own session's — none here.
    expect(drive.recallInvestigations(db, s2, '')).toHaveLength(1);
    expect(drive.listInvestigations(db, s2)).toHaveLength(0);
  });

  it('empty query returns recent (no keyword filter)', () => {
    drive.recordInvestigation(db, { session_id: s1, topic: 'a', summary: 'a' });
    drive.recordInvestigation(db, { session_id: s1, topic: 'b', summary: 'b' });
    expect(drive.recallInvestigations(db, s1, '   ')).toHaveLength(2);
  });

  it('keeps no vector payload or fingerprint in the central table', () => {
    drive.recordInvestigation(db, { session_id: s1, topic: 't', summary: 's' });
    const columns = (db.prepare('PRAGMA table_info(coder_investigations)').all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(columns).not.toContain('embedding');
    expect(columns).not.toContain('embedding_fingerprint');
  });
});

describe('session-drive distributed semantic row resolution', () => {
  it('persists a durable wildcard fence before the relational insert and settles after it', () => {
    const order: string[] = [];
    const sink = {
      noteMutation: vi.fn(),
      beginMutation: vi.fn((input: { namespace: string; itemKeys: readonly string[] }) => {
        order.push(`begin:${drive.listInvestigationsForSemanticIndex(db, 1).length}`);
        expect(input).toMatchObject({
          namespace: 'memory:project:p1', itemKeys: ['*'], operation: 'upsert',
        });
        return { jobId: 4, token: 'fence', namespace: input.namespace };
      }),
      settleMutation: vi.fn(() => {
        order.push(`settle:${drive.listInvestigationsForSemanticIndex(db, 1).length}`);
      }),
    };
    const store = new SessionStore(db, sink);

    const saved = store.recordInvestigation({ session_id: s1, topic: 'fenced', summary: 'safe' });

    expect(saved.project_id).toBe(1);
    expect(order).toEqual(['begin:0', 'settle:1']);
    expect(sink.noteMutation).not.toHaveBeenCalled();
  });

  it('does not expose an unfenced relational row when durable fence creation fails', () => {
    const store = new SessionStore(db, {
      noteMutation: vi.fn(),
      beginMutation: vi.fn(() => { throw new Error('control plane unavailable'); }),
      settleMutation: vi.fn(),
    });

    expect(() => store.recordInvestigation({ session_id: s1, topic: 'unsafe', summary: 'no' }))
      .toThrow('control plane unavailable');
    expect(drive.listInvestigationsForSemanticIndex(db, 1)).toEqual([]);
  });

  it('preserves vector rank order, deduplicates ids, and project-scopes', () => {
    const a = drive.recordInvestigation(db, { session_id: s1, topic: 'auth', summary: 'jwt' });
    const b = drive.recordInvestigation(db, { session_id: s1, topic: 'billing', summary: 'stripe' });
    const c = drive.recordInvestigation(db, { session_id: s1, topic: 'login', summary: 'session' });
    expect(drive.recallInvestigationsByIds(db, s2, [c.id, a.id, c.id, b.id], 3)
      .map((row) => row.topic)).toEqual(['login', 'auth', 'billing']);
    expect(drive.recallInvestigationsByIds(db, s3, [a.id, b.id, c.id], 8)).toEqual([]);
  });

  it('ignores stale/malformed ids and enumerates the project rebuild source', () => {
    const a = drive.recordInvestigation(db, { session_id: s1, topic: 'a', summary: 'one' });
    drive.recordInvestigation(db, { session_id: s3, topic: 'b', summary: 'two' });
    expect(drive.recallInvestigationsByIds(db, s1, [999, -1, a.id], 8)
      .map((row) => row.id)).toEqual([a.id]);
    expect(drive.listInvestigationsForSemanticIndex(db, 1).map((row) => row.id)).toEqual([a.id]);
    expect(drive.investigationProjectId(db, s1)).toBe(1);
  });
});

describe('session-drive file map + aggregate + injection', () => {
  function addToolCall(toolName: string, args: object): void {
    db.prepare(`INSERT INTO coder_messages (session_id, role, content_json) VALUES (?, 'assistant', '[]')`).run(s1);
    const messageId = Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
    db.prepare(
      `INSERT INTO coder_tool_calls (message_id, tool_use_id, tool_name, args_json) VALUES (?, 'u', ?, ?)`,
    ).run(messageId, toolName, JSON.stringify(args));
  }

  it('getFileMap buckets read vs changed and dedups', () => {
    addToolCall('read_file', { path: 'a.ts' });
    addToolCall('read_file', { path: 'a.ts' }); // duplicate read
    addToolCall('read_file', { path: 'b.ts' });
    addToolCall('edit_file', { path: 'b.ts' }); // b.ts is changed → drops from read
    addToolCall('apply_patch', { _raw: '*** Update File: c.ts\n@@\n+x' });
    const map = drive.getFileMap(db, s1);
    expect(map.changed.sort()).toEqual(['b.ts', 'c.ts']);
    expect(map.read).toEqual(['a.ts']);
  });

  it('getDriveInjectionPayload surfaces latest plan + memory + count', () => {
    db.prepare(
      `INSERT INTO coder_plans (session_id, tool_use_id, plan_text, status) VALUES (?, 'p1', 'do the thing', 'approved')`,
    ).run(s1);
    drive.remember(db, s1, { title: 'note', body: 'remember me' });
    drive.recordInvestigation(db, { session_id: s1, topic: 't', summary: 's' });
    const payload = drive.getDriveInjectionPayload(db, s1);
    expect(payload.activePlan).toEqual({ text: 'do the thing', status: 'approved' });
    expect(payload.sessionMemory).toHaveLength(1);
    expect(payload.sessionMemory[0].title).toBe('note');
    expect(payload.investigationCount).toBe(1);
  });

  it('getDriveAggregate returns every section', () => {
    drive.remember(db, s1, { title: 'n', body: 'b' });
    drive.recordInvestigation(db, { session_id: s1, topic: 't', summary: 's' });
    addToolCall('read_file', { path: 'a.ts' });
    const agg = drive.getDriveAggregate(db, s1);
    expect(agg.memory).toHaveLength(1);
    expect(agg.investigations).toHaveLength(1);
    expect(agg.fileMap.read).toEqual(['a.ts']);
    expect(agg.plans).toEqual([]);
    expect(agg.tasks).toBeNull();
  });
});

describe('session-drive command trail + success gate', () => {
  function addShellCall(toolName: string, args: object, isError = false): void {
    db.prepare(`INSERT INTO coder_messages (session_id, role, content_json) VALUES (?, 'assistant', '[]')`).run(s1);
    const messageId = Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
    db.prepare(
      `INSERT INTO coder_tool_calls (message_id, tool_use_id, tool_name, args_json, is_error) VALUES (?, 'u', ?, ?, ?)`,
    ).run(messageId, toolName, JSON.stringify(args), isError ? 1 : 0);
  }

  it('getCommandTrail extracts shell commands oldest→newest (ignoring non-shell tools)', () => {
    addShellCall('run_command', { command: 'pnpm install' });
    addShellCall('exec_command', { cmd: 'pnpm test' });
    addShellCall('read_file', { path: 'a.ts' }); // not a shell tool → ignored
    const trail = drive.getCommandTrail(db, s1);
    expect(trail.map((c) => c.command)).toEqual(['pnpm install', 'pnpm test']);
    expect(trail.every((c) => c.isError === false)).toBe(true);
  });

  it('didRunSucceed reflects the most recent shell command', () => {
    expect(drive.didRunSucceed(db, s1)).toBe(false); // no commands yet
    addShellCall('run_command', { command: 'pnpm test' }, false);
    expect(drive.didRunSucceed(db, s1)).toBe(true);
    addShellCall('run_command', { command: 'pnpm build' }, true); // last command errored
    expect(drive.didRunSucceed(db, s1)).toBe(false);
  });
});
