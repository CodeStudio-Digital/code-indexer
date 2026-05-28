/**
 * Shared types + tiny helpers for the `execute_tasks` orchestrator.
 *
 * Extracted from execute-tasks.ts (PR-A) so future sub-modules
 * (task-run-budget, task-run-persistence, task-retry, task-stale-check)
 * can share the run context shape without import cycles.
 *
 * Kept deliberately small — only types and pure helpers live here. The
 * orchestrator itself stays in `execute-tasks.ts`.
 */
import type { ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { CoderTask, TaskKind, TaskStatus } from '@mcp/code-agent/sessions/types.js';

// ─── Persistence facade (implementation in task-run-persistence.ts) ──

/**
 * Write-through hook fired by the orchestrator at every lifecycle
 * point. The default is a no-op (test mode); the real implementation
 * proxies to `SessionStore.createTaskRun/...` synchronously.
 */
export interface TaskRunPersist {
  recordRunStarted(args: {
    runId: string;
    mode: ExecuteTasksMode;
    startedAt: string;
    budgetTokens?: number | null;
    budgetUsdCents?: number | null;
  }): void;
  recordTaskStarted(args: {
    runId: string;
    task: CoderTask;
    waveIdx: number;
    startedAt: string;
    /** Attempt index (0 = first try, 1 = first retry, ...). Default 0. */
    attempt?: number;
  }): void;
  recordTaskFinished(args: {
    runId: string;
    task: CoderTask;
    waveIdx: number;
    status: TaskStatus;
    finishedAt: string;
    toolCallCount: number;
    usage: ChatUsage;
    summary: string;
    error?: string;
    skipReason?: string;
    inputsFingerprint?: string;
    attempt?: number;
  }): void;
  recordRunFinished(args: {
    runId: string;
    status: 'completed' | 'failed' | 'aborted';
    finishedAt: string;
    totalUsage: ChatUsage;
    rejectReason?: string;
  }): void;
}

/** No-op persistence used by tests and contexts without a SessionStore. */
export const NOOP_PERSIST: TaskRunPersist = {
  recordRunStarted: () => {},
  recordTaskStarted: () => {},
  recordTaskFinished: () => {},
  recordRunFinished: () => {},
};

// ─── Run-level types ────────────────────────────────────────────

export type ExecuteTasksMode = 'auto' | 'inline-all';
export type TaskRunTaskMode = 'subagent' | 'inline';

export interface TaskRunContext {
  runId: string;
  mode: ExecuteTasksMode;
  wave: number;
  totalWaves: number;
  /**
   * Write-through persistence to `coder_task_runs` / `coder_task_run_items`
   * (PR-B). When absent (legacy/test contexts), defaults to `NOOP_PERSIST`
   * so callers never need to null-check.
   */
  persist: TaskRunPersist;
}

/**
 * Limits enforced by the subagent runner for a single task run.
 *
 * Wire-compatible with `SubagentLimits` from implement-subagent.ts —
 * the orchestrator passes this shape straight through.
 */
export interface TaskLimit {
  maxToolCalls?: number;
  timeoutMs?: number;
  stallMs?: number;
}

export interface TaskRunProgressMeta {
  phase?: string;
  lastToolName?: string;
  turn?: number;
  limit?: TaskLimit;
  elapsedMs?: number;
  stallMs?: number;
}

export interface TaskRunResult {
  task: CoderTask;
  status: TaskStatus;
  summary: string;
  error?: string;
  usage: ChatUsage;
  toolCallCount: number;
  wave: number;
}

// ─── Pure helpers ───────────────────────────────────────────────

export function makeTaskRunId(): string {
  return `taskrun_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function taskKind(task: CoderTask): TaskKind {
  return task.kind ?? 'implement';
}

export function accumulateUsage(acc: ChatUsage, add: ChatUsage): void {
  acc.input_tokens += add.input_tokens ?? 0;
  acc.output_tokens += add.output_tokens ?? 0;
  acc.cache_creation_input_tokens =
    (acc.cache_creation_input_tokens ?? 0) + (add.cache_creation_input_tokens ?? 0);
  acc.cache_read_input_tokens =
    (acc.cache_read_input_tokens ?? 0) + (add.cache_read_input_tokens ?? 0);
}

// ─── Status gate (PR-A future-proofing) ─────────────────────────

/**
 * Single entry-point for mutating the in-memory `statusById` map. Today
 * this is just a `Map.set` — wave-groups execute strictly serially in
 * the current orchestrator (`runGroupSequential` awaits each task,
 * `runGroupParallel` awaits the whole `runParallelAgents` batch before
 * touching the map). The gate exists so the refactor to real intra-group
 * parallelism (PR-F or later) can drop in a Mutex/promise-chain here
 * without rewriting every call site.
 *
 * **DO NOT** call `statusById.set(...)` directly anywhere in the
 * orchestrator. The single entry-point is the invariant.
 */
export function applyStatus(
  statusById: Map<string, TaskStatus>,
  taskId: string,
  status: TaskStatus,
): void {
  statusById.set(taskId, status);
}

/**
 * Seed a fresh `statusById` map from the persisted task list. Helper
 * is here (not inline) so tests can construct a snapshot identical to
 * the one the orchestrator sees.
 */
export function seedStatusById(tasks: ReadonlyArray<CoderTask>): Map<string, TaskStatus> {
  return new Map(tasks.map((task) => [task.id, task.status]));
}

// ─── Per-task run-mode resolution ───────────────────────────────

/**
 * Resolve the effective execution mode for a SINGLE task — mirrors the
 * semantics of `resolveEffectiveMode` from tasks.ts (singular path) so
 * `execute_tasks` (wave orchestrator) honours the same dashboard
 * choices.
 *
 * Decision table:
 *
 *   argMode='inline-all'          → 'inline'  (operator override wins)
 *   argMode='auto' (default)      → consult state.execution_mode:
 *     - 'inline'                  → 'inline'
 *     - 'all-subagent'            → 'subagent'
 *     - 'smart' | 'per-task'      → task.suggested_mode (mutated by dashboard for per-task)
 *     - null / undefined          → 'subagent' (legacy default)
 */
export function resolveTaskRunMode(
  task: CoderTask,
  globalMode: import('@mcp/code-agent/sessions/types.js').TaskExecutionMode | null | undefined,
  argMode: ExecuteTasksMode,
): TaskRunTaskMode {
  if (argMode === 'inline-all') return 'inline';
  switch (globalMode) {
    case 'all-subagent':
      return 'subagent';
    case 'inline':
      return 'inline';
    case 'smart':
    case 'per-task':
      return task.suggested_mode === 'inline' ? 'inline' : 'subagent';
    default:
      return 'subagent';
  }
}
