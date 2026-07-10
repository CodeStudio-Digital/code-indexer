import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { getToolCallStats } from '../tool-stats.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE coder_messages (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL);
    CREATE TABLE coder_tool_calls (
      id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL, tool_name TEXT NOT NULL,
      args_json TEXT NOT NULL DEFAULT '{}', result_text TEXT NOT NULL DEFAULT '',
      is_error INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0,
      output_chars INTEGER, output_chars_shaped INTEGER, truncated INTEGER NOT NULL DEFAULT 0,
      refusal_kind TEXT, parent_tool_use_id TEXT, reduction_kind TEXT,
      reduction_technique TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO coder_messages (id, session_id) VALUES (1, 1187);
    INSERT INTO coder_tool_calls
      (id, message_id, tool_name, output_chars, output_chars_shaped, truncated,
       reduction_kind, reduction_technique)
    VALUES (1, 1, 'code_exec', 100, 40, 1, 'hard_cap', 'hard-cap:code_exec');
    INSERT INTO coder_tool_calls
      (id, message_id, tool_name, output_chars, output_chars_shaped,
       reduction_kind, reduction_technique)
    VALUES (2, 1, 'mcp__grep_code', 80, 30, 'semantic', 'mcp__grep_code');
    INSERT INTO coder_tool_calls
      (id, message_id, tool_name, output_chars, output_chars_shaped, parent_tool_use_id)
    VALUES (3, 1, 'mcp__read_file', 1000, NULL, 'parent-code-exec');
  `);
});

afterEach(() => db.close());

describe('tool stats reduction accounting', () => {
  it('separates nested volume from model-facing direct reductions', () => {
    const stats = getToolCallStats(db, 1187);
    expect(stats).toMatchObject({ totalCalls: 3, directCalls: 2, nestedCalls: 1 });
    expect(stats.savings).toMatchObject({
      totalRawChars: 180,
      totalShapedChars: 70,
      totalSavedChars: 110,
      semanticSavedChars: 50,
      hardCapSavedChars: 60,
      nestedRawChars: 1000,
    });
  });
});
