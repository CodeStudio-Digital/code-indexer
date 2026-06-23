/**
 * Persistence bridge for `execute_tasks` (PR-B).
 *
 * The orchestrator calls these hooks at the same points it emits SSE
 * events — start of run, start of task, finish of task, finish of run.
 * Write-through synchronous to SQLite via `SessionStore` (better-sqlite3
 * is ~50µs per insert; no need for async batching).
 *
 * Designed to be inert when the caller doesn't pass a real store —
 * `createTaskRunPersist({ store: null })` returns a no-op object so
 * the test suite doesn't need to spin up a real DB.
 */
import type { SessionStore } from '@mcp/code-agent/sessions/store.js';
import { type TaskRunPersist, NOOP_PERSIST, taskKind } from './task-run-types.js';

export type { TaskRunPersist } from './task-run-types.js';

export interface CreateTaskRunPersistArgs {
  store: SessionStore | null | undefined;
  sessionId: number | null | undefined;
}

/**
 * Construct the persistence facade. When `store` is missing OR
 * `sessionId` is missing (test contexts, inline tools without a
 * real session row), returns a no-op implementation that satisfies
 * the interface — the orchestrator never has to special-case.
 */
export function createTaskRunPersist(args: CreateTaskRunPersistArgs): TaskRunPersist {
  const { store, sessionId } = args;
  if (!store || sessionId == null) return NOOP_PERSIST;

  const guardedCall = (fn: () => void, label: string): void => {
    try {
      fn();
    } catch (e) {
      // Persistence failures must NEVER mask orchestrator state. Log
      // and continue — the in-RAM run keeps going, dashboard just won't
      // reflect it. Better than crashing a 6-task wave on row #4.
      console.warn(
        `[coder/task-runs] persist.${label} failed (run continues): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  return {
    recordRunStarted: (a) => guardedCall(() => {
      store.createTaskRun({
        run_id: a.runId,
        session_id: sessionId,
        mode: a.mode,
        started_at: a.startedAt,
        budget_tokens: a.budgetTokens ?? null,
        budget_usd_cents: a.budgetUsdCents ?? null,
      });
    }, 'recordRunStarted'),
    recordTaskStarted: (a) => guardedCall(() => {
      store.upsertTaskRunItem({
        run_id: a.runId,
        task_id: a.task.id,
        attempt: a.attempt ?? 0,
        wave_idx: a.waveIdx,
        parallel_group: a.task.parallel_group ?? null,
        kind: taskKind(a.task),
        title: a.task.title,
        started_at: a.startedAt,
        status: 'running',
      });
    }, 'recordTaskStarted'),
    recordTaskFinished: (a) => guardedCall(() => {
      store.upsertTaskRunItem({
        run_id: a.runId,
        task_id: a.task.id,
        attempt: a.attempt ?? 0,
        wave_idx: a.waveIdx,
        parallel_group: a.task.parallel_group ?? null,
        kind: taskKind(a.task),
        title: a.task.title,
        finished_at: a.finishedAt,
        status: a.status,
        tool_call_count: a.toolCallCount,
        input_tokens: a.usage.input_tokens ?? 0,
        output_tokens: a.usage.output_tokens ?? 0,
        summary: a.summary,
        ...(a.error ? { error: a.error } : {}),
        ...(a.skipReason ? { skip_reason: a.skipReason } : {}),
        ...(a.inputsFingerprint ? { inputs_fingerprint: a.inputsFingerprint } : {}),
      });
    }, 'recordTaskFinished'),
    recordRunFinished: (a) => guardedCall(() => {
      store.updateTaskRun(a.runId, {
        status: a.status,
        finished_at: a.finishedAt,
        total_input_tokens: a.totalUsage.input_tokens ?? 0,
        total_output_tokens: a.totalUsage.output_tokens ?? 0,
        total_cache_read_tokens: a.totalUsage.cache_read_input_tokens ?? 0,
        total_cache_creation_tokens: a.totalUsage.cache_creation_input_tokens ?? 0,
        ...(a.rejectReason ? { reject_reason: a.rejectReason } : {}),
      });
    }, 'recordRunFinished'),
  };
}

