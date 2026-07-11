import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { getGlobalTelemetrySummary } from '../telemetry-global.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE coder_sessions (
      id INTEGER PRIMARY KEY, project_id INTEGER, title TEXT, provider TEXT, model TEXT
    );
    CREATE TABLE coder_messages (
      id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL
    );
    CREATE TABLE coder_session_inputs (
      id INTEGER PRIMARY KEY, session_id INTEGER, kind TEXT, meta_json TEXT, created_at TEXT
    );
    CREATE TABLE coder_turn_telemetry (
      id INTEGER PRIMARY KEY, session_id INTEGER, provider TEXT, model TEXT,
      request_api_model TEXT, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_input_tokens INTEGER, compaction_triggered INTEGER,
      paginate_count INTEGER, estimated_cost_usd REAL, created_at TEXT
    );
    CREATE TABLE coder_tool_calls (
      id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL, tool_use_id TEXT,
      tool_name TEXT NOT NULL, output_chars INTEGER, duration_ms INTEGER,
      truncated INTEGER NOT NULL DEFAULT 0, phase TEXT, created_at TEXT,
      parent_tool_use_id TEXT, is_error INTEGER NOT NULL DEFAULT 0,
      refusal_kind TEXT, guard_action TEXT, guard_origin_tool_use_id TEXT,
      would_block INTEGER, repeat_policy TEXT, execution_class TEXT,
      result_novel INTEGER, coverage_novel INTEGER, delivered INTEGER
    );
    INSERT INTO coder_sessions (id, title, provider, model)
    VALUES (1, 'guard stats', 'test', 'test-model');
    INSERT INTO coder_messages (id, session_id) VALUES (1, 1);
    INSERT INTO coder_turn_telemetry
      (id, session_id, provider, model, input_tokens, output_tokens,
       cache_read_input_tokens, compaction_triggered, paginate_count,
       estimated_cost_usd, created_at)
    VALUES (1, 1, 'test', 'test-model', 10, 2, 0, 0, 0, 0, datetime('now'));
    INSERT INTO coder_tool_calls
      (id, message_id, tool_use_id, tool_name, is_error, refusal_kind,
       parent_tool_use_id, guard_action, guard_origin_tool_use_id, would_block,
       repeat_policy, execution_class, result_novel, coverage_novel, delivered)
    VALUES
      (1, 1, 'ce#1', 'read_file', 1, 'dedup', 'ce', 'block', NULL, 0, 'stable', 'read', 0, 0, 0),
      (2, 1, 'ce', 'code_exec', 1, 'dedup', NULL, 'block', 'ce#1', 0, 'volatile', 'execute', 0, 0, 1),
      (3, 1, 'cmd', 'run_command', 1, NULL, NULL, NULL, NULL, 0, 'volatile', 'execute', 1, 0, 1),
      (4, 1, 'ce#2', 'read_file', 0, NULL, 'ce', 'reuse', NULL, 0, 'stable', 'read', 0, 0, 1),
      (5, 1, 'git', 'git_status', 0, NULL, NULL, 'shadow', NULL, 1, 'volatile', 'read', 0, 0, 1),
      (6, 1, 'root', 'git_diff', 1, 'dedup', NULL, 'block', 'root', 0, 'volatile', 'read', 0, 0, 1);
  `);
});

afterEach(() => db.close());

describe('global telemetry guard outcomes', () => {
  it('keeps propagated failures separate from root refusals and real errors', () => {
    const summary = getGlobalTelemetrySummary(db);

    expect(summary.top_tools.find((row) => row.name === 'code_exec')).toMatchObject({
      errors: 0,
      refused: 0,
      propagated_failures: 1,
    });
    expect(summary.top_tools.find((row) => row.name === 'read_file')).toMatchObject({
      errors: 0,
      refused: 1,
      reused: 1,
    });
    expect(summary.top_tools.find((row) => row.name === 'run_command')).toMatchObject({
      errors: 1,
    });
    expect(summary.top_tools.find((row) => row.name === 'git_status')).toMatchObject({
      shadow_candidates: 1,
    });
    expect(summary.top_tools.find((row) => row.name === 'git_diff')).toMatchObject({
      refused: 1,
      propagated_failures: 0,
    });
    expect(summary.guard_rollout).toEqual([
      expect.objectContaining({
        repeat_policy: 'volatile',
        execution_class: 'read',
        candidates: 1,
        delivered_candidates: 1,
        confirmed_redundant: 1,
        false_block_signals: 0,
        precision: 1,
        target_candidates: 500,
        eligible_for_enforcement: false,
      }),
    ]);
    expect(summary.guard_rollout[0].confidence_lower_bound).toBeLessThan(0.9);
  });

  it('marks a class eligible only after all rollout thresholds are satisfied', () => {
    db.exec(`
      WITH RECURSIVE seq(x) AS (
        SELECT 1
        UNION ALL
        SELECT x + 1 FROM seq WHERE x < 500
      )
      INSERT INTO coder_tool_calls
        (id, message_id, tool_use_id, tool_name, is_error, guard_action,
         would_block, repeat_policy, execution_class, result_novel,
         coverage_novel, delivered)
      SELECT
        1000 + x, 1, 'shadow-' || x, 'read_file', 0, 'shadow',
        1, 'stable', 'read', CASE WHEN x <= 24 THEN 1 ELSE 0 END,
        0, 1
      FROM seq;
    `);

    const eligible = getGlobalTelemetrySummary(db).guard_rollout
      .find((row) => row.repeat_policy === 'stable' && row.execution_class === 'read');
    expect(eligible).toMatchObject({
      candidates: 500,
      confirmed_redundant: 476,
      false_block_signals: 24,
      precision: 0.952,
      false_block_rate: 0.048,
      eligible_for_enforcement: true,
    });
    expect(eligible!.confidence_lower_bound).toBeGreaterThanOrEqual(0.9);

    // Exactly 5% false-block is not below the rollout's strict <5% limit.
    db.prepare(`UPDATE coder_tool_calls SET result_novel = 1 WHERE id = 1025`).run();
    const ineligible = getGlobalTelemetrySummary(db).guard_rollout
      .find((row) => row.repeat_policy === 'stable' && row.execution_class === 'read');
    expect(ineligible).toMatchObject({
      candidates: 500,
      false_block_signals: 25,
      false_block_rate: 0.05,
      eligible_for_enforcement: false,
    });
  });
});
