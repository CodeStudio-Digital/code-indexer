/**
 * In-flight-turn checkpoint reconciliation (the "estado some ao fechar+reabrir"
 * fix). When a turn parks on `waitForUserInput` (submit_tasks/submit_plan/
 * ask_user/permission gate), the host persists JUST the assistant message
 * (carrying the pending interactive tool_use) so it survives a quit/close. The
 * eventual flush must COMPLETE that same row — never insert a duplicate
 * assistant message. These tests lock in:
 *   1. checkpoint (tool_calls:[] + usage:null) → ONE assistant row, NO paired
 *      tool message, NO usage bump, and a dangling tool_use (resumable),
 *   2. completion via `existing_message_id` → still ONE assistant row, plus the
 *      paired tool message + audit rows + usage bump on the SAME message_id,
 *   3. the per-message token columns are backfilled at completion so
 *      SUM(input_tokens) recomputes (e.g. message-rollback) stay accurate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import * as messages from '../messages.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;
let sessionId: number;

function mkSession(): number {
  db.prepare(`INSERT INTO coder_sessions (project_id, title, provider, model) VALUES (1, 't', 'p', 'm')`).run();
  return Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
}

/** Assistant message that proposes a task list and is awaiting approval. */
function assistantAwaitingTasks(toolUseId: string): AgentMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Here is my plan' },
      { type: 'tool_use' as const, id: toolUseId, name: 'submit_tasks', input: { summary: 's', tasks: [] } },
    ],
  } as AgentMessage;
}

function unmatchedToolUses(msgs: AgentMessage[]): string[] {
  const use = new Set<string>();
  const res = new Set<string>();
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as unknown as Array<Record<string, unknown>>) {
      if (b?.type === 'tool_use' && typeof b.id === 'string') use.add(b.id);
      if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') res.add(b.tool_use_id as string);
    }
  }
  return [...use].filter((id) => !res.has(id));
}

const countRole = (role: string): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM coder_messages WHERE role = ?').get(role) as { n: number }).n;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE coder_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER, title TEXT, provider TEXT, model TEXT,
      total_input_tokens INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0,
      total_cache_read_tokens INTEGER DEFAULT 0,
      total_cache_creation_tokens INTEGER DEFAULT 0,
      last_turn_input_tokens INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE coder_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content_json TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0
    );
    CREATE TABLE coder_tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      tool_use_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args_json TEXT NOT NULL,
      result_text TEXT,
      is_error INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      output_chars INTEGER,
      output_chars_shaped INTEGER,
      output_format TEXT,
      structured_output_chars INTEGER,
      truncated INTEGER NOT NULL DEFAULT 0,
      phase TEXT,
      turn_telemetry_id INTEGER,
      refusal_kind TEXT,
      parent_tool_use_id TEXT,
      error_class TEXT,
      reduction_kind TEXT,
      reduction_technique TEXT,
      reduction_meta_json TEXT,
      output_id TEXT,
      run_id TEXT,
      parent_run_id TEXT,
      is_subagent INTEGER NOT NULL DEFAULT 0,
      subagent_profile TEXT,
      logical_operation_id TEXT,
      productive INTEGER,
      guard_action TEXT,
      guard_reason TEXT,
      would_block INTEGER,
      state_epoch INTEGER,
      result_novel INTEGER,
      coverage_novel INTEGER,
      delivered INTEGER,
      repeat_policy TEXT,
      execution_class TEXT,
      guard_origin_tool_use_id TEXT
    );
  `);
  sessionId = mkSession();
});

afterEach(() => db.close());

describe('persistAssistantTurn — in-flight checkpoint + completion', () => {
  it('checkpoint persists ONLY the assistant message (no paired tool, no bump, dangling tool_use)', () => {
    const messageId = messages.persistAssistantTurn(db, {
      session_id: sessionId,
      message: assistantAwaitingTasks('toolu_tasks'),
      usage: null,
      tool_calls: [],
    });

    expect(messageId).toBeGreaterThan(0);
    expect(countRole('assistant')).toBe(1);
    expect(countRole('tool')).toBe(0); // no paired tool message yet
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM coder_tool_calls').get() as { n: number }).n,
    ).toBe(0);
    // usage:null → totals untouched (the bump happens at completion).
    const totals = db
      .prepare('SELECT total_input_tokens AS i, total_output_tokens AS o FROM coder_sessions WHERE id = ?')
      .get(sessionId) as { i: number; o: number };
    expect(totals).toMatchObject({ i: 0, o: 0 });

    // The interactive tool_use is dangling — exactly what findPendingInteraction
    // keys off to re-offer the approval after a restart.
    const loaded = messages.loadWithMessages(db, sessionId)!;
    expect(unmatchedToolUses(loaded.messages)).toEqual(['toolu_tasks']);
  });

  it('completion via existing_message_id finishes the SAME row — no duplicate assistant message', () => {
    const messageId = messages.persistAssistantTurn(db, {
      session_id: sessionId,
      message: assistantAwaitingTasks('toolu_tasks'),
      usage: null,
      tool_calls: [],
    });

    // User approved → the tool returns; the flush completes the checkpointed row.
    messages.persistAssistantTurn(db, {
      session_id: sessionId,
      existing_message_id: messageId,
      message: assistantAwaitingTasks('toolu_tasks'),
      usage: {
        input_tokens: 100, output_tokens: 20,
        cache_read_input_tokens: 5, cache_creation_input_tokens: 3,
      },
      tool_calls: [{
        tool_use_id: 'toolu_tasks',
        tool_name: 'submit_tasks',
        args: {},
        result_text: 'approved',
        is_error: false,
        duration_ms: 7,
      }],
    });

    // Exactly ONE assistant row (no duplicate), and now ONE paired tool message.
    expect(countRole('assistant')).toBe(1);
    expect(countRole('tool')).toBe(1);

    // The audit row + paired tool_result attach to the checkpointed message id.
    const toolRow = db
      .prepare('SELECT message_id AS mid, tool_use_id AS tid FROM coder_tool_calls')
      .get() as { mid: number; tid: string };
    expect(toolRow).toMatchObject({ mid: messageId, tid: 'toolu_tasks' });

    // tool_use is now matched → resolved (not dangling).
    const loaded = messages.loadWithMessages(db, sessionId)!;
    expect(unmatchedToolUses(loaded.messages)).toEqual([]);

    // Usage bumped once at completion; per-message token columns backfilled so
    // SUM(input_tokens) recomputes (message-rollback) stay correct.
    const session = db
      .prepare('SELECT total_input_tokens AS i, total_output_tokens AS o, last_turn_input_tokens AS l FROM coder_sessions WHERE id = ?')
      .get(sessionId) as { i: number; o: number; l: number };
    expect(session).toMatchObject({ i: 100, o: 20, l: 100 });

    const msgTokens = db
      .prepare('SELECT input_tokens AS i, output_tokens AS o FROM coder_messages WHERE id = ?')
      .get(messageId) as { i: number; o: number };
    expect(msgTokens).toMatchObject({ i: 100, o: 20 });
  });

  it('a non-checkpointed turn still inserts a fresh assistant row (unchanged path)', () => {
    messages.persistAssistantTurn(db, {
      session_id: sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } as AgentMessage,
      usage: { input_tokens: 10, output_tokens: 2 },
      tool_calls: [],
    });
    expect(countRole('assistant')).toBe(1);
    const totals = db
      .prepare('SELECT total_input_tokens AS i FROM coder_sessions WHERE id = ?')
      .get(sessionId) as { i: number };
    expect(totals.i).toBe(10);
  });
});
