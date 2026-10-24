/**
 * Persistence bridge for `execute_tasks` (PR-B).
 *
 * The orchestrator calls these hooks at the same points it emits SSE
 * events — start of run, start of task, finish of task, finish of run.
 * Each lifecycle transition is awaited and atomically written to the owning
 * session bundle. A write failure is a real orchestration failure: execution
 * must not publish a terminal state that recovery cannot observe.
 *
 * Designed to be inert when the caller doesn't pass a real store —
 * `createTaskRunPersist({ store: null })` returns a no-op object so
 * the test suite doesn't need to create a real session bundle.
 */
import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import type { SessionId } from '@mcp/session-storage';
import { type TaskRunPersist, NOOP_PERSIST, taskKind } from './task-run-types.js';

export type { TaskRunPersist } from './task-run-types.js';

export interface CreateTaskRunPersistArgs {
  store: FsSessionStore | null | undefined;
  sessionId: SessionId | null | undefined;
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

  return {
    recordRunStarted: async (a) => {
      await store.createTaskRun({
        run_id: a.runId,
        session_id: sessionId,
        mode: a.mode,
        started_at: a.startedAt,
        budget_tokens: a.budgetTokens ?? null,
        budget_usd_cents: a.budgetUsdCents ?? null,
      });
    },
    recordTaskStarted: async (a) => {
      await store.upsertTaskRunItem({
        session_id: sessionId,
        run_id: a.runId,
        task_id: a.task.id,
        attempt: a.attempt ?? 0,
        wave_idx: a.waveIdx,
        parallel_group: a.task.parallel_group ?? null,
        kind: taskKind(a.task),
        title: a.task.title,
        started_at: a.startedAt,
        finished_at: null,
        status: 'running',
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        inputs_fingerprint: null,
        skip_reason: null,
        error: null,
        summary: null,
      });
    },
    recordTaskFinished: async (a) => {
      await store.upsertTaskRunItem({
        session_id: sessionId,
        run_id: a.runId,
        task_id: a.task.id,
        attempt: a.attempt ?? 0,
        wave_idx: a.waveIdx,
        parallel_group: a.task.parallel_group ?? null,
        kind: taskKind(a.task),
        title: a.task.title,
        started_at: null,
        finished_at: a.finishedAt,
        status: a.status,
        tool_call_count: a.toolCallCount,
        input_tokens: a.usage.input_tokens ?? 0,
        output_tokens: a.usage.output_tokens ?? 0,
        summary: a.summary,
        error: a.error ?? null,
        skip_reason: a.skipReason ?? null,
        inputs_fingerprint: a.inputsFingerprint ?? null,
      });
    },
    recordRunFinished: async (a) => {
      await store.updateTaskRun(sessionId, a.runId, {
        status: a.status,
        finished_at: a.finishedAt,
        total_input_tokens: a.totalUsage.input_tokens ?? 0,
        total_output_tokens: a.totalUsage.output_tokens ?? 0,
        total_cache_read_tokens: a.totalUsage.cache_read_input_tokens ?? 0,
        total_cache_creation_tokens: a.totalUsage.cache_creation_input_tokens ?? 0,
        ...(a.rejectReason ? { reject_reason: a.rejectReason } : {}),
      });
    },
  };
}
