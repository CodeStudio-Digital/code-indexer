import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { getSessionTelemetrySummary } from '../telemetry-session.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE coder_sessions (
      id INTEGER PRIMARY KEY,
      compaction_count_auto INTEGER NOT NULL DEFAULT 0,
      compaction_count_manual INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE coder_messages (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL,
      role TEXT NOT NULL
    );
    CREATE TABLE coder_turn_telemetry (
      id INTEGER PRIMARY KEY,
      session_id INTEGER,
      is_subagent INTEGER NOT NULL DEFAULT 0,
      provider TEXT,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_input_tokens INTEGER,
      cache_creation_input_tokens INTEGER,
      thinking_tokens INTEGER,
      history_chars INTEGER,
      tool_count INTEGER NOT NULL DEFAULT 0,
      tools_called_json TEXT,
      largest_tool_result_chars INTEGER,
      compaction_triggered INTEGER NOT NULL DEFAULT 0,
      summarizer_ran INTEGER NOT NULL DEFAULT 0,
      paginate_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT,
      estimated_cost_usd REAL,
      system_prompt_chars INTEGER,
      tools_def_chars INTEGER
    );
    CREATE TABLE coder_tool_calls (
      id INTEGER PRIMARY KEY,
      message_id INTEGER NOT NULL,
      tool_use_id TEXT,
      tool_name TEXT NOT NULL,
      output_chars INTEGER,
      output_chars_shaped INTEGER,
      output_format TEXT,
      structured_output_chars INTEGER,
      duration_ms INTEGER,
      truncated INTEGER NOT NULL DEFAULT 0,
      phase TEXT,
      parent_tool_use_id TEXT,
      is_error INTEGER NOT NULL DEFAULT 0,
      refusal_kind TEXT,
      guard_action TEXT,
      guard_origin_tool_use_id TEXT,
      would_block INTEGER
    );
    INSERT INTO coder_sessions (id, compaction_count_auto)
    VALUES (1221, 5);
  `);
});

afterEach(() => db.close());

describe('getSessionTelemetrySummary', () => {
  it('does not fail when a pre-repair database lacks eligible_tools_def_chars', () => {
    const summary = getSessionTelemetrySummary(db, 1221);

    expect(summary.turn_count).toBe(0);
    expect(summary.compaction_count_auto).toBe(5);
    expect(summary.tools_breakdown).toEqual([]);
    expect(summary.estimated_cost_usd).toBe(0);
  });

  it('does not double-count a nested refusal propagated through code_exec', () => {
    db.exec(`
      INSERT INTO coder_messages (id, session_id, role) VALUES (1, 1221, 'assistant');
      INSERT INTO coder_tool_calls
        (id, message_id, tool_use_id, tool_name, is_error, refusal_kind, parent_tool_use_id,
         guard_action, guard_origin_tool_use_id, would_block)
      VALUES
        (1, 1, 'ce-1#1', 'read_file', 1, 'dedup', 'ce-1', 'block', NULL, 0),
        (2, 1, 'ce-1', 'code_exec', 1, 'dedup', NULL, 'block', 'ce-1#1', 0),
        (3, 1, 'run-1', 'run_command', 1, NULL, NULL, NULL, NULL, 0),
        (4, 1, 'ce-2#1', 'read_file', 0, NULL, 'ce-2', 'reuse', NULL, 0),
        (5, 1, 'git-1', 'git_status', 0, NULL, NULL, 'shadow', NULL, 1);
    `);

    const summary = getSessionTelemetrySummary(db, 1221);
    expect(summary.tools_breakdown.find((row) => row.name === 'read_file')).toMatchObject({
      errors: 0,
      refused: 1,
      propagated_failures: 0,
      reused: 1,
    });
    expect(summary.tools_breakdown.find((row) => row.name === 'code_exec')).toMatchObject({
      errors: 0,
      refused: 0,
      propagated_failures: 1,
    });
    expect(summary.tools_breakdown.find((row) => row.name === 'run_command')).toMatchObject({
      errors: 1,
    });
    expect(summary.tools_breakdown.find((row) => row.name === 'git_status')).toMatchObject({
      shadow_candidates: 1,
    });
  });

  it('compares canonical structured size with model-delivered Markdown size', () => {
    db.exec(`
      INSERT INTO coder_messages (id, session_id, role) VALUES (1, 1221, 'assistant');
      INSERT INTO coder_tool_calls
        (id, message_id, tool_name, output_chars, output_chars_shaped, output_format, structured_output_chars)
      VALUES
        (1, 1, 'app_get_context', 700, 600, 'markdown', 1000),
        (2, 1, 'app_get_spec', 450, 400, 'markdown', 800),
        (3, 1, 'plain_text', 50, 50, 'text', NULL);
    `);

    expect(getSessionTelemetrySummary(db, 1221).structured_output).toEqual({
      calls: 2,
      structured_chars: 1800,
      delivered_chars: 1000,
      saved_chars: 800,
      reduction_ratio: 800 / 1800,
    });
  });
});
