import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';
import { runDurableCompaction } from '@mcp/code-agent/core/runner/compaction/durable-compaction.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';

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

    const res = store.setCompactionBoundary(sessionId, 'SUMMARY TEXT', boundary, 'manual');
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
    store.setCompactionBoundary(sessionId, 'HEAD SUMMARY', boundary, 'auto');

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
    store.setCompactionBoundary(sessionId, 'S', boundary, 'auto');
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

    store.setCompactionBoundary(sessionId, 'S', store.maxMessageId(sessionId), 'manual');
    expect(store.getSession(sessionId)?.last_response_id).toBeNull();
  });

  it('advancing the boundary is cumulative and non-destructive', () => {
    seed(3);
    store.setCompactionBoundary(sessionId, 'S1', store.maxMessageId(sessionId), 'auto');
    seed(2); // two more turns after the first boundary
    const second = store.maxMessageId(sessionId);
    const res = store.setCompactionBoundary(sessionId, 'S2', second, 'manual');

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

  it('runDurableCompaction keeps >= the message floor of renderable tail on a dense autonomous run', async () => {
    const ENV_KEYS = [
      'CODER_COMPACT_PROTECT_RATIO',
      'CODER_COMPACT_PRESERVE_LAST_N_TURNS',
      'CODER_COMPACT_MIN_TAIL_TURNS',
      'CODER_COMPACT_MIN_TAIL_FRACTION',
    ] as const;
    const saved: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    // Tiny token tail + floor pinned to 8 + user-turn recede disabled — so the
    // message-count floor is the thing keeping the recent tail.
    process.env.CODER_COMPACT_PROTECT_RATIO = '0.02';
    process.env.CODER_COMPACT_PRESERVE_LAST_N_TURNS = '0';
    process.env.CODER_COMPACT_MIN_TAIL_TURNS = '8';
    process.env.CODER_COMPACT_MIN_TAIL_FRACTION = '0';
    try {
      // 1 user request, then 20 dense (assistant tool_use → big tool_result) turns.
      store.appendMessage(sessionId, { role: 'user', content: [{ type: 'text', text: 'build the feature' }] });
      for (let i = 0; i < 20; i++) {
        store.appendMessage(sessionId, {
          role: 'assistant', content: [{ type: 'tool_use', id: `id${i}`, name: 'read_file', input: {} }],
        });
        store.appendMessage(sessionId, {
          role: 'tool',
          content: [{ type: 'tool_result', tool_use_id: `id${i}`, content: `contents of f${i} `.repeat(400) }],
        });
      }

      const res = await runDurableCompaction({
        store,
        sessionId,
        provider: { model: 'fake-model-xyz' } as unknown as ChatProvider, // 128K fallback window
        summarize: async () => ({
          primary_request: 'build the feature',
          key_concepts: [], files_and_code: [], errors_and_fixes: [],
          problem_solving: '', all_user_messages: ['build the feature'],
          pending_tasks: [], current_work: '', next_step: '',
        }),
      });

      expect(res.ok).toBe(true);
      expect(res.prunedCount).toBeGreaterThan(0); // it really moved a boundary
      // Visible tail after the boundary must retain at least the 8-turn floor.
      const visible = store.loadSessionWithMessages(sessionId);
      const renderableVisible = (visible?.messages ?? []).filter((m) => m.role !== 'tool').length;
      expect(renderableVisible).toBeGreaterThanOrEqual(8);
    } finally {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it('bumps the per-kind durable-compaction counters (migration 130)', () => {
    const counts = () => db.raw().prepare(
      'SELECT compaction_count_auto AS a, compaction_count_manual AS m FROM coder_sessions WHERE id = ?',
    ).get(sessionId) as { a: number; m: number };

    expect(counts()).toEqual({ a: 0, m: 0 });

    seed(4);
    store.setCompactionBoundary(sessionId, 'A1', store.maxMessageId(sessionId), 'auto');
    expect(counts()).toEqual({ a: 1, m: 0 });

    seed(2);
    store.setCompactionBoundary(sessionId, 'M1', store.maxMessageId(sessionId), 'manual');
    expect(counts()).toEqual({ a: 1, m: 1 });

    seed(2);
    store.setCompactionBoundary(sessionId, 'A2', store.maxMessageId(sessionId), 'auto');
    expect(counts()).toEqual({ a: 2, m: 1 });
  });
});
