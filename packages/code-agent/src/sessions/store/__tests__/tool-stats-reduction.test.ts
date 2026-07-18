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
      id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL, tool_use_id TEXT,
      tool_name TEXT NOT NULL,
      args_json TEXT NOT NULL DEFAULT '{}', result_text TEXT NOT NULL DEFAULT '',
      is_error INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0,
      output_chars INTEGER, output_chars_shaped INTEGER, truncated INTEGER NOT NULL DEFAULT 0,
      refusal_kind TEXT, parent_tool_use_id TEXT, reduction_kind TEXT,
      reduction_technique TEXT, guard_action TEXT, guard_reason TEXT,
      would_block INTEGER, guard_origin_tool_use_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
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

  it('never treats marker-like result text as reduction telemetry', () => {
    db.prepare(`
      INSERT INTO coder_tool_calls
        (id, message_id, tool_name, result_text, output_chars, output_chars_shaped, truncated)
      VALUES (?, 1, 'run_command', ?, 80, 80, 0)
    `).run(
      10,
      '[truncated: printed by the command] json-crush [smart-reducer: plain text]',
    );

    const stats = getToolCallStats(db, 1187);
    const none = stats.savings.byTechnique.find((row) => row.kind === 'none');
    expect(none).toMatchObject({ technique: 'none', calls: 1 });
    expect(stats.savings.byTechnique.some((row) => (
      row.technique === 'legacy-hard-cap'
      || row.technique === 'legacy-json-crush'
      || row.technique === 'legacy-semantic'
    ))).toBe(false);
  });

  it('accounts producer-declared caps in their own reduction tier', () => {
    db.prepare(`
      INSERT INTO coder_tool_calls
        (id, message_id, tool_name, output_chars, output_chars_shaped, truncated,
         reduction_kind, reduction_technique)
      VALUES (?, 1, 'web_fetch', 80, 80, 1, 'source_cap', 'source-cap:web-body-limit')
    `).run(11);

    const stats = getToolCallStats(db, 1187);
    expect(stats.savings.byTechnique).toContainEqual(expect.objectContaining({
      kind: 'source_cap',
      technique: 'source-cap:web-body-limit',
      calls: 1,
    }));
  });

  it('separates root refusals from propagated parent failures and guard savings', () => {
    db.exec(`
      INSERT INTO coder_tool_calls
        (id, message_id, tool_use_id, tool_name, is_error, refusal_kind, parent_tool_use_id,
         guard_action, guard_reason)
      VALUES
        (4, 1, 'ce-root#1', 'mcp__read_file', 1, 'dedup', 'ce-root', 'block', 'mutating-repeat'),
        (5, 1, 'ce-root', 'code_exec', 1, 'dedup', NULL, 'block', 'nested-refusal');
      UPDATE coder_tool_calls
         SET guard_origin_tool_use_id = 'ce-root#1'
       WHERE id = 5;
      INSERT INTO coder_tool_calls
        (id, message_id, tool_name, is_error)
      VALUES (6, 1, 'run_command', 1);
      INSERT INTO coder_tool_calls
        (id, message_id, tool_name, parent_tool_use_id, guard_action, guard_reason)
      VALUES (7, 1, 'mcp__read_file', 'ce-reuse', 'reuse', 'same-scope-stable-call');
      INSERT INTO coder_tool_calls
        (id, message_id, tool_name, guard_action, would_block, guard_reason)
      VALUES (8, 1, 'git_status', 'shadow', 1, 'no-progress');
      INSERT INTO coder_tool_calls
        (id, message_id, tool_use_id, tool_name, is_error, refusal_kind,
         guard_action, guard_origin_tool_use_id, guard_reason)
      VALUES (9, 1, 'direct-root', 'git_diff', 1, 'dedup',
              'block', 'direct-root', 'mutating-repeat');
    `);

    const stats = getToolCallStats(db, 1187, 20);

    expect(stats.guardOutcomes).toEqual({
      genuineErrors: 1,
      rootRefusals: 2,
      propagatedParentFailures: 1,
      reusedCalls: 1,
      shadowCandidates: 1,
    });
    expect(stats.byName.find((row) => row.name === 'code_exec')).toMatchObject({
      errorCount: 0,
      refusedCount: 0,
      propagatedFailureCount: 1,
    });
    expect(stats.byName.find((row) => row.name === 'mcp__read_file')).toMatchObject({
      refusedCount: 1,
      reuseCount: 1,
    });
    expect(stats.recent.slice(0, 4).map((row) => row.outcome)).toEqual([
      'root_refusal',
      'shadow',
      'genuine_error',
      'propagated_parent_failure',
    ]);
  });
});
