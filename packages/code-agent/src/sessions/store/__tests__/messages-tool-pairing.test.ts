/**
 * persistAssistantTurn must persist the PAIRED tool-role message (the
 * `tool_result` blocks) alongside the assistant message + audit rows, in one
 * transaction. The dashboard derives a tool call's status purely from the
 * presence of a matching `tool_result` block, so a dropped tool message shows a
 * perpetual "loading" spinner (session 969). These tests lock in:
 *   1. a tool turn → an assistant row AND a paired tool row (ids match),
 *   2. a text-only turn → no tool row,
 *   3. N turns → N paired tool rows (the compaction array-reassignment
 *      regression: the old host path lost tool messages after a mid-run
 *      compaction reassigned the live message array),
 *   4. the `getToolResultsByToolUseIds` audit fallback used to heal old sessions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import * as messages from '../messages.js';
import * as toolResults from '../tool-results.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;
let sessionId: number;

function mkSession(): number {
  db.prepare(`INSERT INTO coder_sessions (project_id, title, provider, model) VALUES (1, 't', 'p', 'm')`).run();
  return Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
}

function assistantWithTools(tools: Array<{ id: string; name: string }>): AgentMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: 'doing things' },
      ...tools.map((t) => ({ type: 'tool_use' as const, id: t.id, name: t.name, input: {} })),
    ],
  } as AgentMessage;
}

function toolCalls(tools: Array<{ id: string; name: string; isError?: boolean }>) {
  return tools.map((t) => ({
    tool_use_id: t.id,
    tool_name: t.name,
    args: {},
    result_text: `result for ${t.id}`,
    is_error: !!t.isError,
    duration_ms: 5,
  }));
}

/** Mirror the dashboard: a tool_use with no matching tool_result block = "loading". */
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

beforeEach(() => {
  db = new Database(':memory:');
  // Minimal subset of the prod coder_* schema that persistAssistantTurn /
  // loadWithMessages / getToolResultsByToolUseIds touch. Hand-rolled rather
  // than via runMigrations because the full chain also pulls in the indexer
  // tables that need the sqlite-vec / FTS5 extensions, which a bare
  // better-sqlite3 in vitest does not load.
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
      truncated INTEGER NOT NULL DEFAULT 0,
      phase TEXT,
      turn_telemetry_id INTEGER,
      refusal_kind TEXT
    );
  `);
  sessionId = mkSession();
});

afterEach(() => db.close());

describe('persistAssistantTurn — paired tool-role message', () => {
  it('writes a tool message whose tool_result ids match the assistant tool_use ids', () => {
    messages.persistAssistantTurn(db, {
      session_id: sessionId,
      message: assistantWithTools([
        { id: 'toolu_a', name: 'read_file' },
        { id: 'toolu_b', name: 'write_file' },
      ]),
      usage: null,
      tool_calls: toolCalls([
        { id: 'toolu_a', name: 'read_file' },
        { id: 'toolu_b', name: 'write_file', isError: true },
      ]),
    });

    const loaded = messages.loadWithMessages(db, sessionId)!;
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[0].role).toBe('assistant');
    expect(loaded.messages[1].role).toBe('tool');

    const toolBlocks = loaded.messages[1].content as unknown as Array<Record<string, unknown>>;
    expect(toolBlocks.map((b) => b.tool_use_id)).toEqual(['toolu_a', 'toolu_b']);
    expect(toolBlocks.find((b) => b.tool_use_id === 'toolu_b')!.is_error).toBe(true);
    expect(unmatchedToolUses(loaded.messages)).toEqual([]);
  });

  it('writes NO tool message for a text-only turn', () => {
    messages.persistAssistantTurn(db, {
      session_id: sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] } as AgentMessage,
      usage: null,
      tool_calls: [],
    });
    const loaded = messages.loadWithMessages(db, sessionId)!;
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.messages[0].role).toBe('assistant');
  });

  it('persists every turn across many turns (compaction array-reassignment regression)', () => {
    for (let i = 0; i < 6; i++) {
      messages.persistAssistantTurn(db, {
        session_id: sessionId,
        message: assistantWithTools([{ id: `toolu_${i}`, name: 'read_file' }]),
        usage: null,
        tool_calls: toolCalls([{ id: `toolu_${i}`, name: 'read_file' }]),
      });
    }
    const loaded = messages.loadWithMessages(db, sessionId)!;
    const roles = loaded.messages.map((m) => m.role);
    expect(roles.filter((r) => r === 'assistant')).toHaveLength(6);
    expect(roles.filter((r) => r === 'tool')).toHaveLength(6);
    expect(unmatchedToolUses(loaded.messages)).toEqual([]);
  });
});

describe('getToolResultsByToolUseIds — audit fallback for old sessions', () => {
  it('returns recorded results for the given ids, scoped to the session', () => {
    messages.persistAssistantTurn(db, {
      session_id: sessionId,
      message: assistantWithTools([{ id: 'toolu_x', name: 'glob' }]),
      usage: null,
      tool_calls: toolCalls([{ id: 'toolu_x', name: 'glob', isError: true }]),
    });
    const got = toolResults.getToolResultsByToolUseIds(db, sessionId, ['toolu_x', 'toolu_missing']);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ tool_use_id: 'toolu_x', result_text: 'result for toolu_x', is_error: true });
  });

  it('returns empty for an empty id list', () => {
    expect(toolResults.getToolResultsByToolUseIds(db, sessionId, [])).toEqual([]);
  });
});
