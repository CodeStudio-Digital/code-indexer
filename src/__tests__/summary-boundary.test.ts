import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';

/**
 * Migration 128 — durable compaction boundary (prepend model). The summary is
 * stored on the session (`compaction_summary`) + a `summary_boundary_id`; the
 * runner prepends the summary and the dashboard renders it as a card. Loaders
 * hide rows at/below the boundary by default while keeping them recoverable.
 * Shared by the manual "summarize & clear" (boundary = MAX id, no tail) and the
 * automatic durable compaction (boundary = a mid id, recent tail stays visible).
 */
describe('durable compaction boundary', () => {
  let dir: string;
  let dbPath: string;
  let db: CodeIndexDB;
  let store: SessionStore;
  let sessionId: number;

  const seed = (n: number): number[] => {
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(store.appendMessage(sessionId, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: `msg ${i}` }],
      }));
    }
    return ids;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-durable-boundary-'));
    dbPath = join(dir, 'test.db');
    db = new CodeIndexDB(dbPath);
    store = new SessionStore(dbPath);
    db.raw().prepare(
      `INSERT INTO projects (id, name, root_path, created_at)
       VALUES (1, 'Demo', '/srv/demo', datetime('now'))`,
    ).run();
    sessionId = store.createSession({
      project_id: 1, title: 'sess', provider: 'anthropic', model: 'claude',
    }).id;
  });

  afterEach(() => {
    store.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('no boundary by default — loaders see the full transcript, no summary', () => {
    seed(5);
    expect(store.getMessageCount(sessionId)).toBe(5);
    expect(store.getArchivedMessageCount(sessionId)).toBe(0);
    expect(store.getSummaryBoundary(sessionId)).toBe(0);
    expect(store.loadSessionWithMessages(sessionId)?.messages).toHaveLength(5);
    expect(store.getSession(sessionId)?.compaction_summary).toBeNull();
  });

  it('full clear: boundary = MAX(id) hides everything, summary stored on session', () => {
    const ids = seed(5);
    const boundary = store.maxMessageId(sessionId);
    expect(boundary).toBe(ids[ids.length - 1]);

    const res = store.setCompactionBoundary(sessionId, 'SUMMARY TEXT', boundary);
    expect(res.boundary_id).toBe(boundary);
    expect(res.pruned_count).toBe(5);

    expect(store.loadSessionWithMessages(sessionId)?.messages).toHaveLength(0);
    expect(store.getMessageCount(sessionId)).toBe(0);
    expect(store.getArchivedMessageCount(sessionId)).toBe(5);
    expect(store.getSummaryBoundary(sessionId)).toBe(boundary);
    expect(store.getSession(sessionId)?.compaction_summary).toBe('SUMMARY TEXT');
  });

  it('tail-preserving (auto): mid boundary keeps the recent tail visible', () => {
    const ids = seed(5); // ids[0..4]
    const boundary = ids[2]; // hide first 3, keep last 2 (the recent tail)
    store.setCompactionBoundary(sessionId, 'HEAD SUMMARY', boundary);

    const visible = store.loadSessionWithMessages(sessionId);
    expect(visible?.messages).toHaveLength(2);
    expect(visible?.message_rows.every((r) => r.id > boundary)).toBe(true);
    expect(store.getArchivedMessageCount(sessionId)).toBe(3);

    const tail = store.loadSessionMessagesTail(sessionId, 60);
    expect(tail?.messages).toHaveLength(2);
  });

  it('loadMessagesBefore stops at the boundary unless includeArchived crosses it', () => {
    const ids = seed(5);
    const boundary = ids[2];
    store.setCompactionBoundary(sessionId, 'S', boundary);
    const firstVisibleId = ids[3];

    const guarded = store.loadMessagesBefore(sessionId, firstVisibleId, 50);
    expect(guarded.message_rows).toHaveLength(0);

    const revealed = store.loadMessagesBefore(sessionId, firstVisibleId, 50, true);
    expect(revealed.message_rows).toHaveLength(3);
    expect(revealed.message_rows.every((r) => r.id <= boundary)).toBe(true);
  });

  it('clears the ChatGPT response pointer so the delta re-establishes', () => {
    seed(4);
    store.setLastResponseState(sessionId, 'resp_123', 4);
    expect(store.getSession(sessionId)?.last_response_id).toBe('resp_123');

    store.setCompactionBoundary(sessionId, 'S', store.maxMessageId(sessionId));
    expect(store.getSession(sessionId)?.last_response_id).toBeNull();
  });

  it('advancing the boundary is cumulative and non-destructive', () => {
    seed(3);
    store.setCompactionBoundary(sessionId, 'S1', store.maxMessageId(sessionId));
    seed(2); // two more turns after the first boundary
    const second = store.maxMessageId(sessionId);
    const res = store.setCompactionBoundary(sessionId, 'S2', second);

    expect(res.pruned_count).toBe(2); // only the rows since the prior boundary
    expect(store.getMessageCount(sessionId)).toBe(0);
    expect(store.getArchivedMessageCount(sessionId)).toBe(5);
    expect(store.getSession(sessionId)?.compaction_summary).toBe('S2');
    // Nothing deleted: all 5 rows still in the table.
    const total = (db.raw().prepare(
      'SELECT COUNT(*) AS c FROM coder_messages WHERE session_id = ?',
    ).get(sessionId) as { c: number }).c;
    expect(total).toBe(5);
  });
});
