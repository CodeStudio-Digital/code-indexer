import type { Database as DB } from 'better-sqlite3';

/** Additive persisted contract; older rows naturally expose null/default fields. */
export interface SubagentRunTelemetry {
  session_id: number | null;
  run_id: string;
  parent_run_id: string | null;
  spawn_id: string | null;
  profile: string;
  label: string | null;
  task_preview: string | null;
  max_turns: number;
  max_tool_calls: number | null;
  timeout_ms: number | null;
  stall_ms: number | null;
  reason: string | null;
  turns: number;
  auto_continues: number;
  tool_calls: number;
  logical_operations: number;
  productive_operations: number;
  paginate_calls: number;
  duplicate_calls: number;
  error_calls: number;
  refused_calls: number;
  elapsed_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  has_summary: 0 | 1;
  output_id: string | null;
}

export interface StartSubagentRunInput {
  session_id: number | null;
  run_id: string;
  parent_run_id?: string | null;
  spawn_id?: string | null;
  profile: string;
  label?: string | null;
  task_preview?: string | null;
  max_turns: number;
  max_tool_calls?: number | null;
  timeout_ms?: number | null;
  stall_ms?: number | null;
}

export interface SubagentToolCallInput {
  session_id: number | null;
  run_id: string;
  seq: number;
  turn?: number | null;
  tool_name: string;
  logical_operation_id?: string | null;
  productive?: boolean;
  is_error: boolean;
  refusal_kind?: string | null;
  duration_ms: number;
  result_chars: number;
}

export interface CompleteSubagentRunInput {
  run_id: string;
  reason: string;
  turns: number;
  auto_continues: number;
  tool_calls: number;
  logical_operations: number;
  productive_operations: number;
  paginate_calls: number;
  duplicate_calls: number;
  error_calls: number;
  refused_calls: number;
  elapsed_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  has_summary: boolean;
  output_id?: string | null;
}

export function start(db: DB, input: StartSubagentRunInput): void {
  db.prepare(`
    INSERT INTO coder_subagent_runs (
      session_id, run_id, parent_run_id, spawn_id, profile, label, task_preview,
      max_turns, max_tool_calls, timeout_ms, stall_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      parent_run_id=excluded.parent_run_id, profile=excluded.profile,
      label=excluded.label, task_preview=excluded.task_preview
  `).run(
    input.session_id, input.run_id, input.parent_run_id ?? null,
    input.spawn_id ?? null, input.profile, input.label ?? null,
    input.task_preview?.slice(0, 1000) ?? null, input.max_turns,
    input.max_tool_calls ?? null, input.timeout_ms ?? null, input.stall_ms ?? null,
  );
}

export function recordToolCall(db: DB, input: SubagentToolCallInput): void {
  db.prepare(`
    INSERT OR IGNORE INTO coder_subagent_tool_calls (
      session_id, run_id, seq, turn, tool_name, logical_operation_id,
      productive, is_error, refusal_kind, duration_ms, result_chars
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.session_id, input.run_id, input.seq, input.turn ?? null,
    input.tool_name, input.logical_operation_id ?? null, input.productive ? 1 : 0,
    input.is_error ? 1 : 0, input.refusal_kind ?? null,
    input.duration_ms, input.result_chars,
  );
}

export function complete(db: DB, input: CompleteSubagentRunInput): void {
  db.prepare(`
    UPDATE coder_subagent_runs SET
      reason=?, turns=?, auto_continues=?, tool_calls=?, logical_operations=?,
      productive_operations=?, paginate_calls=?, duplicate_calls=?, error_calls=?,
      refused_calls=?, elapsed_ms=?, input_tokens=?, output_tokens=?,
      cache_read_input_tokens=?, cache_creation_input_tokens=?, has_summary=?,
      output_id=?, completed_at=datetime('now')
    WHERE run_id=?
  `).run(
    input.reason, input.turns, input.auto_continues, input.tool_calls,
    input.logical_operations, input.productive_operations, input.paginate_calls,
    input.duplicate_calls, input.error_calls, input.refused_calls, input.elapsed_ms,
    input.input_tokens, input.output_tokens, input.cache_read_input_tokens ?? 0,
    input.cache_creation_input_tokens ?? 0, input.has_summary ? 1 : 0,
    input.output_id ?? null, input.run_id,
  );
}
