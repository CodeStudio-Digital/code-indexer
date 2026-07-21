import type { Database as DB } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const WORKER_INSTANCE_ID = `${process.pid}:${randomUUID()}`;

export function currentSubagentWorkerInstanceId(): string {
  return WORKER_INSTANCE_ID;
}

/** Additive persisted contract; older rows naturally expose null/default fields. */
export interface SubagentRunTelemetry {
  id: number;
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
  research_depth: string | null;
  soft_tool_target: number | null;
  soft_time_target_ms: number | null;
  synthesis_nudged: 0 | 1;
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
  started_at: string;
  completed_at: string | null;
  status: 'running' | 'completed' | 'interrupted';
  heartbeat_at: string | null;
  worker_instance_id: string | null;
}

export interface SubagentToolCallTelemetry {
  id: number;
  session_id: number | null;
  run_id: string;
  seq: number;
  turn: number | null;
  tool_name: string;
  logical_operation_id: string | null;
  productive: 0 | 1;
  is_error: 0 | 1;
  refusal_kind: string | null;
  duration_ms: number;
  result_chars: number;
  created_at: string;
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
  research_depth?: string | null;
  soft_tool_target?: number | null;
  soft_time_target_ms?: number | null;
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
  synthesis_nudged?: boolean;
}

export function start(db: DB, input: StartSubagentRunInput): void {
  // A session has one owning coder worker. A new worker instance starting a
  // child means incomplete rows from a different instance are crash orphans.
  if (input.session_id != null) {
    recoverOrphaned(db, {
      sessionId: input.session_id,
      currentWorkerInstanceId: WORKER_INSTANCE_ID,
    });
  }
  db.prepare(`
    INSERT INTO coder_subagent_runs (
      session_id, run_id, parent_run_id, spawn_id, profile, label, task_preview,
      max_turns, max_tool_calls, timeout_ms, stall_ms, research_depth,
      soft_tool_target, soft_time_target_ms, status, heartbeat_at, worker_instance_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', datetime('now'), ?)
    ON CONFLICT(run_id) DO UPDATE SET
      parent_run_id=excluded.parent_run_id, profile=excluded.profile,
      label=excluded.label, task_preview=excluded.task_preview,
      research_depth=excluded.research_depth,
      soft_tool_target=excluded.soft_tool_target,
      soft_time_target_ms=excluded.soft_time_target_ms,
      status='running', heartbeat_at=datetime('now'),
      worker_instance_id=excluded.worker_instance_id, completed_at=NULL
  `).run(
    input.session_id, input.run_id, input.parent_run_id ?? null,
    input.spawn_id ?? null, input.profile, input.label ?? null,
    input.task_preview?.slice(0, 1000) ?? null, input.max_turns,
    input.max_tool_calls ?? null, input.timeout_ms ?? null, input.stall_ms ?? null,
    input.research_depth ?? null, input.soft_tool_target ?? null,
    input.soft_time_target_ms ?? null, WORKER_INSTANCE_ID,
  );
}

export function heartbeat(db: DB, runId: string): void {
  db.prepare(`
    UPDATE coder_subagent_runs
    SET heartbeat_at=datetime('now')
    WHERE run_id=? AND status='running' AND completed_at IS NULL
  `).run(runId);
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
  heartbeat(db, input.run_id);
}

export function complete(db: DB, input: CompleteSubagentRunInput): void {
  db.prepare(`
    UPDATE coder_subagent_runs SET
      reason=?, turns=?, auto_continues=?, tool_calls=?, logical_operations=?,
      productive_operations=?, paginate_calls=?, duplicate_calls=?, error_calls=?,
      refused_calls=?, elapsed_ms=?, input_tokens=?, output_tokens=?,
      cache_read_input_tokens=?, cache_creation_input_tokens=?, has_summary=?,
      output_id=?, synthesis_nudged=?, status='completed',
      heartbeat_at=datetime('now'), completed_at=datetime('now')
    WHERE run_id=?
  `).run(
    input.reason, input.turns, input.auto_continues, input.tool_calls,
    input.logical_operations, input.productive_operations, input.paginate_calls,
    input.duplicate_calls, input.error_calls, input.refused_calls, input.elapsed_ms,
    input.input_tokens, input.output_tokens, input.cache_read_input_tokens ?? 0,
    input.cache_creation_input_tokens ?? 0, input.has_summary ? 1 : 0,
    input.output_id ?? null, input.synthesis_nudged ? 1 : 0, input.run_id,
  );
}

export interface RecoverOrphanedSubagentRunsOptions {
  sessionId?: number;
  /** When set, preserve incomplete rows owned by this live worker instance. */
  currentWorkerInstanceId?: string;
}

/**
 * Mark incomplete rows left by a dead/replaced worker as terminal. Idempotent;
 * completed rows and rows owned by the current worker are never touched.
 */
export function recoverOrphaned(
  db: DB,
  opts: RecoverOrphanedSubagentRunsOptions = {},
): number {
  const table = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='coder_subagent_runs'",
  ).get();
  if (!table) return 0;
  const columns = new Set(
    (db.prepare('PRAGMA table_info(coder_subagent_runs)').all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  if (!columns.has('status') || !columns.has('heartbeat_at') || !columns.has('worker_instance_id')) return 0;

  const where: string[] = ["completed_at IS NULL", "status = 'running'"];
  const params: unknown[] = [];
  if (opts.sessionId != null) {
    where.push('session_id = ?');
    params.push(opts.sessionId);
  }
  if (opts.currentWorkerInstanceId) {
    where.push('(worker_instance_id IS NULL OR worker_instance_id <> ?)');
    params.push(opts.currentWorkerInstanceId);
  }
  const result = db.prepare(`
    UPDATE coder_subagent_runs
    SET status='interrupted', reason=COALESCE(reason, 'worker_restart'),
        heartbeat_at=datetime('now'), completed_at=datetime('now')
    WHERE ${where.join(' AND ')}
  `).run(...params);
  return result.changes;
}

export function listRuns(db: DB, sessionId: number, limit = 50): SubagentRunTelemetry[] {
  return db.prepare(`
    SELECT * FROM coder_subagent_runs
    WHERE session_id = ?
    ORDER BY started_at DESC, id DESC
    LIMIT ?
  `).all(sessionId, Math.max(1, Math.min(200, limit))) as SubagentRunTelemetry[];
}

export function listToolCalls(db: DB, runId: string, limit = 100): SubagentToolCallTelemetry[] {
  return db.prepare(`
    SELECT * FROM coder_subagent_tool_calls
    WHERE run_id = ?
    ORDER BY seq DESC
    LIMIT ?
  `).all(runId, Math.max(1, Math.min(500, limit))) as SubagentToolCallTelemetry[];
}
