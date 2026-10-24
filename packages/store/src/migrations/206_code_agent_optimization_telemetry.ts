/**
 * Migration 206 — structured reduction + subagent attribution telemetry.
 * Additive and guarded because project DBs trim all coder/quality tables.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
}

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  if (!tableExists(db, table)) return;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const codeAgentOptimizationTelemetry206: Migration = {
  version: 206,
  name: 'code_agent_optimization_telemetry',
  up: (db: DB): void => {
    for (const [column, definition] of [
      ['reduction_kind', 'TEXT'],
      ['reduction_technique', 'TEXT'],
      ['reduction_meta_json', 'TEXT'],
      ['output_id', 'TEXT'],
      ['run_id', 'TEXT'],
      ['parent_run_id', 'TEXT'],
      ['is_subagent', 'INTEGER NOT NULL DEFAULT 0'],
      ['subagent_profile', 'TEXT'],
      ['logical_operation_id', 'TEXT'],
      ['productive', 'INTEGER'],
    ] as const) addColumnIfMissing(db, 'coder_tool_calls', column, definition);

    for (const [column, definition] of [
      ['parent_run_id', 'TEXT'],
      ['subagent_profile', 'TEXT'],
      ['auto_continues', 'INTEGER NOT NULL DEFAULT 0'],
      ['logical_operation_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['productive_operation_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['eligible_tools_def_chars', 'INTEGER'],
    ] as const) addColumnIfMissing(db, 'coder_turn_telemetry', column, definition);

    for (const [column, definition] of [
      ['coder_run_id', 'TEXT'],
      ['parent_run_id', 'TEXT'],
      ['is_subagent', 'INTEGER NOT NULL DEFAULT 0'],
      ['subagent_profile', 'TEXT'],
    ] as const) addColumnIfMissing(db, 'quality_classifications', column, definition);

    if (!tableExists(db, 'coder_sessions')) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS coder_subagent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER,
        run_id TEXT NOT NULL UNIQUE,
        parent_run_id TEXT,
        spawn_id TEXT,
        profile TEXT NOT NULL,
        label TEXT,
        task_preview TEXT,
        max_turns INTEGER,
        max_tool_calls INTEGER,
        timeout_ms INTEGER,
        stall_ms INTEGER,
        reason TEXT,
        turns INTEGER NOT NULL DEFAULT 0,
        auto_continues INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        logical_operations INTEGER NOT NULL DEFAULT 0,
        productive_operations INTEGER NOT NULL DEFAULT 0,
        paginate_calls INTEGER NOT NULL DEFAULT 0,
        duplicate_calls INTEGER NOT NULL DEFAULT 0,
        error_calls INTEGER NOT NULL DEFAULT 0,
        refused_calls INTEGER NOT NULL DEFAULT 0,
        elapsed_ms INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_input_tokens INTEGER,
        cache_creation_input_tokens INTEGER,
        has_summary INTEGER NOT NULL DEFAULT 0,
        output_id TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_coder_subagent_runs_session
        ON coder_subagent_runs(session_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_coder_subagent_runs_parent
        ON coder_subagent_runs(parent_run_id, started_at);

      CREATE TABLE IF NOT EXISTS coder_subagent_tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER,
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        turn INTEGER,
        tool_name TEXT NOT NULL,
        logical_operation_id TEXT,
        productive INTEGER NOT NULL DEFAULT 0,
        is_error INTEGER NOT NULL DEFAULT 0,
        refusal_kind TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        result_chars INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_coder_subagent_tool_call_seq
        ON coder_subagent_tool_calls(run_id, seq);
      CREATE INDEX IF NOT EXISTS idx_coder_subagent_tool_calls_session
        ON coder_subagent_tool_calls(session_id, created_at);
    `);
  },
};
