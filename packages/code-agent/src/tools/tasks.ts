/**
 * Structured task list tools — submit_tasks / execute_task / task_complete.
 *
 * The orchestrator (parent coder agent) explores the codebase, decomposes the
 * work into a curated task list with files + references per task, and submits
 * it via submit_tasks. The user reviews and approves in the dashboard. Then
 * the orchestrator calls execute_task once per task in dependency order; each
 * task runs either inline (current parent context) or in an isolated subagent
 * (Phase 2 — for now only inline is supported).
 *
 * Token economy is the goal: by curating a small list of files and references
 * per task, we can ship subagents an order of magnitude less context than the
 * parent's full history.
 */
import { randomUUID } from 'node:crypto';
import type { CoderTool, ToolResult, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type {
  CoderTask,
  TaskExecutionMode,
  TaskReference,
  TasksState,
} from '@mcp/code-agent/sessions/types.js';
import { extractPathsFromToolArgs, isPathInsideScope } from '@mcp/code-agent/core/runner.js';
import { runImplementSubagent } from '@mcp/code-agent/tools/implement-subagent.js';
import {
  SUBMIT_TASKS_DESC,
  EXECUTE_TASK_DESC,
  TASK_COMPLETE_DESC,
  TASK_LIST_DESC,
  maybeTerse,
} from '@mcp/code-agent/tools/descriptions.js';
import { todoWrite, updateTodo } from '@mcp/code-agent/tools/todo.js';

// ─── Burst guard for submit_tasks ───────────────────────────────
//
// Mirrors the create_goal / todo_write burst guards. When the agent
// reissues `submit_tasks` with the same logical task list 3+ times in 90s
// without anything changing in between, refuse hard and point at
// update_task. The signature includes the summary plus sorted title/body
// pairs so backend-generated ids don't make each duplicate look new.

const SUBMIT_BURST_BY_RUNNER = new WeakMap<object, { count: number; lastAt: number; lastSig: string }>();
const SUBMIT_BURST_THRESHOLD = 3;
const SUBMIT_BURST_WINDOW_MS = 90_000;

function tasksSignature(summary: string, tasks: ReadonlyArray<{ title: string; description: string }>): string {
  const logicalItems = tasks.map((t) => `${t.title}:${t.description}`).sort().join('|');
  return `${summary.trim()}::${logicalItems}`;
}

function readRunnerKey(ctx: { runner?: unknown }): object | null {
  return (ctx.runner as unknown as object) ?? null;
}

function bumpSubmitBurst(ctx: { runner?: unknown }, sig: string): { count: number } {
  const key = readRunnerKey(ctx);
  if (!key) return { count: 0 };
  const now = Date.now();
  const prior = SUBMIT_BURST_BY_RUNNER.get(key);
  if (!prior || now - prior.lastAt > SUBMIT_BURST_WINDOW_MS || prior.lastSig !== sig) {
    SUBMIT_BURST_BY_RUNNER.set(key, { count: 1, lastAt: now, lastSig: sig });
    return { count: 1 };
  }
  const next = { count: prior.count + 1, lastAt: now, lastSig: sig };
  SUBMIT_BURST_BY_RUNNER.set(key, next);
  return { count: next.count };
}

/** Test-only: clear submit_tasks burst tracker for a runner key. */
export function _resetSubmitBurstForKey(key: object): void {
  SUBMIT_BURST_BY_RUNNER.delete(key);
}

// ─── Validation helpers ─────────────────────────────────────────

/**
 * Levenshtein distance for short strings — used to suggest "did you mean"
 * when the model passes a hallucinated task_id.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) dp[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = i - 1;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j - 1], dp[j]) + 1;
      prev = tmp;
    }
  }
  return dp[b.length];
}

/**
 * Build a structured, recovery-oriented error message for execute_task.
 * Lists valid IDs by status group and suggests the closest match if any
 * id or title is within Levenshtein distance 3 of the bad input.
 */
function buildTaskIdErrorMessage(badId: string, state: TasksState, prefix: string): string {
  const pending: CoderTask[] = [];
  const failed: CoderTask[] = [];
  const inProgress: CoderTask[] = [];
  for (const t of state.tasks) {
    if (t.status === 'pending' || t.status === 'interrupted') pending.push(t);
    else if (t.status === 'failed') failed.push(t);
    else if (t.status === 'running') inProgress.push(t);
  }

  const fmt = (t: CoderTask) => `  - id=${t.id} "${t.title}"`;
  const sections: string[] = [`${prefix}`];
  if (pending.length) {
    sections.push('Valid pending tasks:');
    sections.push(...pending.map(fmt));
  }
  if (failed.length) {
    sections.push('Failed tasks (retryable):');
    sections.push(...failed.map(fmt));
  }
  if (inProgress.length) {
    sections.push('Currently running:');
    sections.push(...inProgress.map(fmt));
  }
  if (!pending.length && !failed.length && !inProgress.length) {
    sections.push('(no actionable tasks remain — all may be done/skipped)');
  }

  // Did-you-mean: closest match across ids and titles within distance 3.
  const candidates: { id: string; label: string; dist: number }[] = [];
  for (const t of [...pending, ...failed, ...inProgress]) {
    const dId = levenshtein(badId.toLowerCase(), t.id.toLowerCase());
    const dTitle = levenshtein(badId.toLowerCase(), t.title.toLowerCase());
    const dist = Math.min(dId, dTitle);
    if (dist <= 3) candidates.push({ id: t.id, label: t.title, dist });
  }
  candidates.sort((a, b) => a.dist - b.dist);
  if (candidates.length > 0) {
    sections.push(`Did you mean '${candidates[0].id}' ("${candidates[0].label}")?`);
  }

  sections.push('Hint: pass an exact id from the list above. If unsure, the orchestrator can re-list tasks.');
  return sections.join('\n');
}

function validateReference(r: unknown): TaskReference | string {
  if (!r || typeof r !== 'object') return 'reference must be an object';
  const o = r as Record<string, unknown>;
  if (typeof o.type !== 'string') return 'reference.type required';
  if (typeof o.value !== 'string' || !o.value.trim()) return 'reference.value required';
  if (!['symbol', 'snippet', 'file', 'doc'].includes(o.type)) {
    return `reference.type '${String(o.type)}' invalid (use symbol|snippet|file|doc)`;
  }
  const ref: TaskReference = { type: o.type as TaskReference['type'], value: o.value } as TaskReference;
  if (typeof o.file === 'string' && o.file.trim()) ref.file = o.file;
  if (typeof o.lines === 'string' && o.lines.trim()) ref.lines = o.lines;
  if (typeof o.note === 'string' && o.note.trim()) ref.note = o.note;
  return ref;
}

function makeTaskId(): string {
  return `tsk_${randomUUID()}`;
}

function looksLikeGeneratedTaskId(id: string): boolean {
  return id.startsWith('tsk_');
}

function looksLikeLegacyTaskId(id: string): boolean {
  return /^task[_-]?\d+$/i.test(id) || /^\d+$/.test(id);
}

function validateTaskInput(raw: unknown, idx: number): CoderTask | string {
  if (!raw || typeof raw !== 'object') return `tasks[${idx}] must be an object`;
  const o = raw as Record<string, unknown>;
  // `id` is now only an optional client alias used to resolve depends_on
  // inside this submit_tasks call. The backend replaces it with a unique
  // generated `tsk_...` id before persistence so new rounds never inherit
  // lifecycle state from previous "task_1" style ids.
  const rawId = typeof o.id === 'string' ? o.id.trim() : '';
  const id = rawId || `task_${idx + 1}`;
  const title = String(o.title ?? '').trim();
  if (!title) return `tasks[${idx}].title required`;
  const description = String(o.description ?? '').trim();
  if (!description) return `tasks[${idx}].description required`;
  const files = Array.isArray(o.files) ? o.files.filter((f): f is string => typeof f === 'string') : [];
  const referencesRaw = Array.isArray(o.references) ? o.references : [];
  const references: TaskReference[] = [];
  for (let i = 0; i < referencesRaw.length; i++) {
    const r = validateReference(referencesRaw[i]);
    if (typeof r === 'string') return `tasks[${idx}].references[${i}]: ${r}`;
    references.push(r);
  }
  const dependsOn = Array.isArray(o.depends_on)
    ? o.depends_on.filter((d): d is string => typeof d === 'string')
    : [];
  const suggestedMode = o.suggested_mode === 'subagent' ? 'subagent' : 'inline';
  const complexity = ['small', 'medium', 'large'].includes(String(o.estimated_complexity))
    ? (o.estimated_complexity as 'small' | 'medium' | 'large')
    : 'medium';

  // NEW (PR 2): kind drives execute_tasks dispatch.
  // Defaults to 'implement' (conservative — write access) when omitted so
  // existing prompts that don't yet emit `kind` keep working.
  const kindRaw = String(o.kind ?? '').trim();
  const kind: 'investigate' | 'implement' | 'verify' =
    kindRaw === 'investigate' || kindRaw === 'verify' ? kindRaw : 'implement';

  // NEW (PR 2): parallel_group — string label for wave-level batching.
  // Tasks sharing this label AND without unfinished mutual deps run
  // concurrently. Empty string is treated as "no group" (serial).
  const parallelGroup =
    typeof o.parallel_group === 'string' && o.parallel_group.trim()
      ? o.parallel_group.trim()
      : undefined;

  if (suggestedMode === 'subagent' && kind === 'implement' && files.length === 0) {
    return `tasks[${idx}] (${id}): implement subagent tasks must declare at least one file in scope`;
  }

  return {
    id,
    title,
    description,
    files,
    references,
    depends_on: dependsOn,
    suggested_mode: suggestedMode,
    estimated_complexity: complexity,
    kind,
    parallel_group: parallelGroup,
    status: 'pending',
  };
}

export function validateTasksInput(raw: unknown): { summary: string; tasks: CoderTask[] } | string {
  if (!raw || typeof raw !== 'object') return 'input must be an object';
  const o = raw as Record<string, unknown>;
  const summary = String(o.summary ?? '').trim();
  if (!summary) return 'summary required';
  if (!Array.isArray(o.tasks) || o.tasks.length === 0) return 'tasks must be a non-empty array';
  if (o.tasks.length < 2) {
    return 'submit_tasks requires 2+ independent tasks. For a single linear action, call submit_plan instead — it is lighter and faster to approve.';
  }
  const tasks: CoderTask[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < o.tasks.length; i++) {
    const t = validateTaskInput(o.tasks[i], i);
    if (typeof t === 'string') return t;
    if (seen.has(t.id)) return `duplicate task id: ${t.id}`;
    seen.add(t.id);
    tasks.push(t);
  }
  // Validate depends_on references after we know all ids.
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (!seen.has(dep)) return `task ${t.id} depends_on '${dep}' which doesn't exist`;
    }
  }

  const idMap = new Map<string, string>();
  for (const t of tasks) {
    idMap.set(t.id, makeTaskId());
  }
  const generated = tasks.map((t) => ({
    ...t,
    id: idMap.get(t.id)!,
    depends_on: t.depends_on.map((dep) => idMap.get(dep)!),
  }));
  return { summary, tasks: generated };
}

// ─── Format helpers (cache-stable) ──────────────────────────────

/** Byte-stable text emitted as the tool_result of submit_tasks. Mirroring
 *  formatPlanResult from plan.ts so cache prefixes don't churn on resume. */
export function formatTasksApprovedResult(state: TasksState, feedback?: string): string {
  const lines: string[] = [];
  lines.push(`Task list approved by user. Execution mode: ${state.execution_mode ?? 'inline'}.`);
  if (feedback) lines.push(`Feedback: ${feedback}`);
  lines.push('');
  lines.push('Tasks (in execution order respecting depends_on):');
  for (const t of state.tasks) {
    const deps = t.depends_on.length > 0 ? ` (after: ${t.depends_on.join(', ')})` : '';
    lines.push(`- ${t.id}: ${t.title}${deps}`);
  }
  lines.push('');
  // PR 3: prefer the wave-based orchestrator. Falls back to the singular
  // workflow only when execute_tasks is unavailable (no subagent
  // capability — Company master, CODER_DISABLE_SUBAGENTS=1).
  lines.push(
    'Call `execute_tasks` ONCE to run the whole approved list. ' +
    'It walks the dependency graph, batches independent tasks into parallel waves ' +
    '(by `parallel_group`), and spawns the right subagent kind per task ' +
    '(investigate/implement/verify). Returns a consolidated summary. ' +
    'Inline-mode tasks open a scope on this runner; close each one with `task_complete` ' +
    'and call `execute_tasks` again to advance.',
  );
  return lines.join('\n');
}

export function formatTasksRejectedResult(feedback?: string): string {
  return `Task list rejected by user.${feedback ? ` Feedback: ${feedback}` : ''} Revise the tasks and call submit_tasks again.`;
}

export function formatTaskCompletedResult(taskId: string, summary: string, nextTaskId: string | null): string {
  if (nextTaskId) {
    // execute_tasks (plural) is the only registered orchestrator — it re-derives
    // the next runnable task itself, so don't point at the unregistered singular
    // execute_task or pass a task_id.
    return `Task ${taskId} marked as done. Summary: ${summary}\n\nNext task ready: ${nextTaskId}. Call execute_tasks() again to advance.`;
  }
  return `Task ${taskId} marked as done. Summary: ${summary}\n\nAll tasks complete. You may now respond to the user with a final wrap-up.`;
}

// ─── Tools ──────────────────────────────────────────────────────

const submitTasksSchema: JsonSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '1-2 line statement of the overall objective' },
    tasks: {
      type: 'array',
      description: 'List of curated task units. Order them so depends_on is respected.',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description:
              'Optional client alias used only within this submit_tasks call for depends_on references. The backend replaces it with a generated tsk_... id before execution.',
          },
          title: { type: 'string', description: '1-line label shown to the user.' },
          description: { type: 'string', description: '3-10 lines: what to do + the success criterion.' },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Project-relative paths the task may read AND write. Required for subagent mode.',
          },
          references: {
            type: 'array',
            items: { type: 'object' },
            description: "Curated context pre-extracted by you. Each entry: {type: 'symbol'|'snippet'|'file'|'doc', value: string, file?: string, lines?: string, note?: string}.",
          },
          depends_on: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional client aliases from this submit_tasks call that must finish before this task starts. The backend rewrites them to generated tsk_... ids.',
          },
          suggested_mode: {
            type: 'string',
            enum: ['inline', 'subagent'],
            description: "'inline' = execute in the parent context (good for tasks needing prior history). 'subagent' = isolated subagent with only this task's files+references (token-cheap).",
          },
          estimated_complexity: { type: 'string', enum: ['small', 'medium', 'large'] },
          kind: {
            type: 'string',
            enum: ['investigate', 'implement', 'verify'],
            description:
              "What KIND of work this task is — drives toolset selection in execute_tasks:\n" +
              "  'investigate' → read-only exploration (cheaper, no write access).\n" +
              "  'implement'   → read + write + shell, scoped to `files` (default).\n" +
              "  'verify'      → run_command + read + lsp_diagnostics only (tests, linters).\n" +
              "Defaults to 'implement' when omitted.",
          },
          parallel_group: {
            type: 'string',
            description:
              "Optional label for parallel batching. Tasks sharing the same `parallel_group` " +
              "AND with no unfinished dependency on each other run CONCURRENTLY in the same wave. " +
              "Omit (or empty) to keep the task strictly sequential.",
          },
        },
        required: ['title', 'description', 'files', 'suggested_mode', 'estimated_complexity'],
      },
    },
  },
  required: ['summary', 'tasks'],
} as unknown as JsonSchema;

export const submitTasks: CoderTool = {
  name: 'submit_tasks',
  description: maybeTerse(SUBMIT_TASKS_DESC),
  source: 'native',
  parameters: submitTasksSchema,
  handler: async (args, ctx): Promise<ToolResult> => {
    const validated = validateTasksInput(args);
    if (typeof validated === 'string') return err(`submit_tasks validation failed: ${validated}`);

    const runner = ctx.runner;
    if (!runner) return err('submit_tasks requires runner context');

    // Burst guard: refuse repeated re-submissions of the same logical list.
    const sig = tasksSignature(validated.summary, validated.tasks);
    const burst = bumpSubmitBurst(ctx, sig);
    if (burst.count > SUBMIT_BURST_THRESHOLD) {
      const ids = validated.tasks.map((t) => t.id).join(', ');
      return err(
        `Refused: submit_tasks called ${burst.count} times in the last ${Math.round(SUBMIT_BURST_WINDOW_MS / 1000)}s ` +
          `with the same logical task list. Use update_task({task_id: "...", status: "..."}) to mutate ` +
          `existing tasks (status, files, title) instead of resubmitting the whole list. ` +
          `Current ids: ${ids}.`,
      );
    }

    const toolUseId = `tasks_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const initialState: TasksState = {
      gate: 'approve',
      summary: validated.summary,
      tasks: validated.tasks,
      execution_mode: null,
      approved: false,
      current_task_id: null,
    };
    ctx.recordTasks?.(toolUseId, initialState);
    runner.emit('tasks_posted', {
      tool_use_id: toolUseId,
      summary: initialState.summary,
      tasks: initialState.tasks,
      version: 1,
    });

    const raw = await runner.waitForUserInput();
    let parsed: {
      approved?: boolean;
      feedback?: string;
      aborted?: boolean;
      tasks?: CoderTask[];
      execution_mode?: TaskExecutionMode;
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { approved: false, feedback: raw };
    }

    if (parsed.aborted) {
      ctx.resolveTasks?.({ approved: false });
      return err('Task list review aborted by user.');
    }
    if (parsed.approved) {
      const resolvedMode = parsed.execution_mode ?? 'inline';
      console.log(
        `[coder/tasks] submit_tasks approved — execution_mode=${resolvedMode} ` +
        `(received=${parsed.execution_mode ?? 'undefined'}) tasks=${parsed.tasks?.length ?? '?'}`,
      );
      ctx.resolveTasks?.({
        approved: true,
        tasks: parsed.tasks,
        execution_mode: resolvedMode,
      });
      runner.markTasksApproved();
      const finalState = ctx.getTasksState?.() ?? {
        ...initialState,
        approved: true,
        execution_mode: resolvedMode,
        tasks: parsed.tasks ?? initialState.tasks,
      };
      return ok(formatTasksApprovedResult(finalState, parsed.feedback));
    }
    ctx.resolveTasks?.({ approved: false });
    return ok(formatTasksRejectedResult(parsed.feedback));
  },
};

// ─── execute_task ───────────────────────────────────────────────

function resolveEffectiveMode(
  task: CoderTask,
  globalMode: TaskExecutionMode | null,
  override?: 'inline' | 'subagent'
): 'inline' | 'subagent' {
  if (override) return override;
  switch (globalMode) {
    case 'all-subagent':
      return 'subagent';
    case 'inline':
    case null:
    case undefined:
      return 'inline';
    case 'smart':
    case 'per-task':
      return task.suggested_mode;
    default:
      return 'inline';
  }
}

const executeTaskSchema: JsonSchema = {
  type: 'object',
  properties: {
    task_id: { type: 'string', description: 'id of the task to execute (from the approved task list)' },
    mode_override: {
      type: 'string',
      enum: ['inline', 'subagent'],
      description: 'Override the user-chosen execution mode for this single task. Rare — usually let the resolved mode stand.',
    },
  },
  required: ['task_id'],
} as unknown as JsonSchema;

export const executeTask: CoderTool = {
  name: 'execute_task',
  description: maybeTerse(EXECUTE_TASK_DESC),
  source: 'native',
  parameters: executeTaskSchema,
  handler: async (args, ctx): Promise<ToolResult> => {
    const taskId = String((args as { task_id?: unknown }).task_id ?? '').trim();
    if (!taskId) return err('execute_task: task_id required');
    const override = (args as { mode_override?: unknown }).mode_override;
    const overrideMode = override === 'inline' || override === 'subagent' ? override : undefined;

    const runner = ctx.runner;
    if (!runner) return err('execute_task requires runner context');
    const state = ctx.getTasksState?.();
    if (!state) return err('execute_task: no task list found. Call submit_tasks first.');
    if (!state.approved) return err('execute_task: task list not yet approved by user.');

    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) {
      if (looksLikeLegacyTaskId(taskId) || !looksLikeGeneratedTaskId(taskId)) {
        return err(
          `execute_task: invalid task_id '${taskId}'. Task ids are generated by submit_tasks and look like 'tsk_...'. ` +
            'Call list_tasks() and pass an exact id from the approved task list.',
        );
      }
      return err(buildTaskIdErrorMessage(taskId, state, `execute_task: unknown task_id '${taskId}'.`));
    }
    const retryable: ReadonlySet<string> = new Set(['pending', 'interrupted', 'failed']);
    if (!retryable.has(task.status)) {
      return err(
        buildTaskIdErrorMessage(
          taskId,
          state,
          `execute_task: task '${taskId}' has status '${task.status}', expected one of: ${[...retryable].join(', ')}.`,
        ),
      );
    }
    // Check dependencies
    for (const dep of task.depends_on) {
      const depTask = state.tasks.find((t) => t.id === dep);
      if (!depTask) {
        return err(
          buildTaskIdErrorMessage(
            dep,
            state,
            `execute_task: task '${taskId}' depends on unknown id '${dep}'.`,
          ),
        );
      }
      if (depTask.status !== 'done' && depTask.status !== 'skipped') {
        return err(
          `execute_task: task '${taskId}' is blocked — dependency '${dep}' ("${depTask.title}") has status '${depTask.status}'. ` +
            `Wait for it to reach 'done' or 'skipped' (run execute_task on '${dep}' first if it is 'pending'/'failed'/'interrupted').`,
        );
      }
    }

    const effectiveMode = resolveEffectiveMode(task, state.execution_mode, overrideMode);
    console.log(
      `[coder/tasks] execute_task task_id=${taskId} state.execution_mode=${state.execution_mode ?? 'null'} ` +
      `suggested_mode=${task.suggested_mode} override=${overrideMode ?? 'none'} → effective=${effectiveMode}`,
    );

    if (effectiveMode === 'subagent') {
      // Subagent mode: spin up an isolated CoderRunner with the curated
      // implement allowlist + path-scope warning sandbox. The orchestrator
      // BLOCKS on the subagent's run; we never open a task scope on the
      // parent runner. Cost accounting flows back via subUsage on ToolResult.
      const startedAt = new Date().toISOString();
      ctx.updateTaskStatus?.(taskId, {
        status: 'running',
        mode_used: 'subagent',
        started_at: startedAt,
      });
      runner.emit('task_started', { task_id: taskId, mode: 'subagent', started_at: startedAt });

      let taskResult;
      try {
        taskResult = await runImplementSubagent(
          {
            provider: runner.provider,
            tools: runner.getToolListSnapshot(),
            ctx,
            sessionId: runner.sessionId,
            sessionStore: runner.sessionStore,
            // PR-6 R23: propagate v2 framing/features to the inline implement subagent.
            agentLoopV2: runner.agentLoopV2,
          },
          task
        );
      } catch (e) {
        taskResult = {
          summary: 'subagent crashed before producing a result',
          files_modified: [],
          errors: e instanceof Error ? e.message : String(e),
        };
      }

      const finishedAt = new Date().toISOString();
      const status = taskResult.errors ? 'failed' : 'done';
      ctx.updateTaskStatus?.(taskId, {
        status,
        finished_at: finishedAt,
        result: taskResult,
      });
      runner.emit('task_finished', { task_id: taskId, status, result: taskResult, finished_at: finishedAt });

      // Surface subagent token usage to the parent's totalUsage via subUsage.
      // The parent runner's loop already adds it (see runner.ts ~line 482).
      const subUsage = taskResult.subagent_usage as
        | { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
        | undefined;

      // Find the next pending task to nudge the orchestrator forward.
      const nextState = ctx.getTasksState?.();
      let nextTaskId: string | null = null;
      if (nextState) {
        for (const t of nextState.tasks) {
          if (t.status !== 'pending') continue;
          const allDepsDone = t.depends_on.every((d) => {
            const dep = nextState.tasks.find((x) => x.id === d);
            return dep?.status === 'done' || dep?.status === 'skipped';
          });
          if (allDepsDone) {
            nextTaskId = t.id;
            break;
          }
        }
      }

      const violationLine =
        taskResult.sandbox_violations && taskResult.sandbox_violations.length > 0
          ? `\n\n⚠️  Sandbox warnings: subagent touched paths outside the declared scope: [${taskResult.sandbox_violations.join(', ')}]`
          : '';
      const errorLine = taskResult.errors ? `\n\n❌ Errors: ${taskResult.errors}` : '';
      const nextLine = nextTaskId
        ? `\n\nNext task ready: ${nextTaskId}. Call execute_task with task_id="${nextTaskId}" to continue.`
        : '\n\nAll tasks complete. You may now respond to the user with a final wrap-up.';
      const filesLine =
        taskResult.files_modified.length > 0
          ? `\nFiles modified: ${taskResult.files_modified.join(', ')}`
          : '';

      const body = `Task ${taskId} (${status}) — subagent: ${taskResult.summary}${filesLine}${violationLine}${errorLine}${nextLine}`;

      return {
        ...ok(body),
        subUsage: subUsage
          ? {
              input_tokens: subUsage.input_tokens ?? 0,
              output_tokens: subUsage.output_tokens ?? 0,
              cache_read_input_tokens: subUsage.cache_read_input_tokens,
              cache_creation_input_tokens: subUsage.cache_creation_input_tokens,
            }
          : undefined,
      };
    }

    // Inline mode: open the task scope on the parent runner.
    const startedAt = new Date().toISOString();
    ctx.updateTaskStatus?.(taskId, {
      status: 'running',
      mode_used: 'inline',
      started_at: startedAt,
    });
    runner.beginTaskScope({ id: task.id, files: task.files });
    runner.emit('task_started', { task_id: taskId, mode: 'inline', started_at: startedAt });

    const fileList = task.files.length > 0 ? task.files.map((f) => `  - ${f}`).join('\n') : '  (none declared)';
    return ok(
      `Task scope ACTIVE for task '${taskId}': ${task.title}\n\n` +
        `${task.description}\n\n` +
        `Files in scope (mutating tools allowed only inside these):\n${fileList}\n\n` +
        `Proceed with the implementation in your next turns using write_file/edit_file/run_command/etc. ` +
        `When the task is complete (or has failed), call task_complete(task_id="${taskId}", summary, files_modified, errors?). ` +
        `You CANNOT call submit_plan, submit_tasks, ask_user, or execute_task again until you close this scope.`
    );
  },
};

// ─── list_tasks ─────────────────────────────────────────────────

const listTasksSchema: JsonSchema = {
  type: 'object',
  properties: {
    statuses: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional status filter: pending, running, done, failed, skipped, interrupted.',
    },
  },
  additionalProperties: false,
} as unknown as JsonSchema;

export const listTasks: CoderTool = {
  name: 'list_tasks',
  description:
    'List the current approved/pending task list with generated task ids. Use before execute_task/update_task if you are unsure which task id is current.',
  source: 'native',
  mutates: false,
  parallelSafe: true,
  riskLevel: 'read',
  parameters: listTasksSchema,
  handler: async (args, ctx): Promise<ToolResult> => {
    const state = ctx.getTasksState?.();
    if (!state) return err('list_tasks: no task list found. Call submit_tasks first.');
    const rawStatuses = Array.isArray(args.statuses) ? args.statuses.filter((s): s is string => typeof s === 'string') : [];
    const statusFilter = rawStatuses.length > 0 ? new Set(rawStatuses) : null;
    const tasks = statusFilter ? state.tasks.filter((t) => statusFilter.has(t.status)) : state.tasks;
    const lines: string[] = [
      `Task list: ${state.summary}`,
      `approved=${state.approved} execution_mode=${state.execution_mode ?? 'null'} current_task_id=${state.current_task_id ?? 'null'}`,
      '',
      'Tasks:',
    ];
    for (const t of tasks) {
      const deps = t.depends_on.length > 0 ? ` after=[${t.depends_on.join(', ')}]` : '';
      const files = t.files.length > 0 ? ` files=[${t.files.join(', ')}]` : '';
      lines.push(`- id=${t.id} status=${t.status} kind=${t.kind ?? 'implement'} title="${t.title}"${deps}${files}`);
    }
    if (tasks.length === 0) lines.push('(no tasks match the requested filter)');
    return ok(lines.join('\n'));
  },
};

// ─── task list mutation helpers ─────────────────────────────────

function persistTaskList(ctx: { recordTasks?: (toolUseId: string, state: TasksState) => void }, state: TasksState): void {
  ctx.recordTasks?.(`tasks_edit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, state);
}

function emitTaskListUpdated(runner: { emit: (event: 'task_updated', payload: { task_id: string; patch: Partial<CoderTask> }) => void }): void {
  runner.emit('task_updated', { task_id: '__task_list__', patch: {} });
}

function parseTaskIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const id = v.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function validateKnownTaskIds(state: TasksState, taskIds: string[], toolName: string): string | null {
  for (const id of taskIds) {
    if (state.tasks.some((t) => t.id === id)) continue;
    if (looksLikeLegacyTaskId(id) || !looksLikeGeneratedTaskId(id)) {
      return `${toolName}: invalid task_id '${id}'. Task ids are generated by submit_tasks and look like 'tsk_...'. Call list_tasks() and pass exact ids.`;
    }
    return buildTaskIdErrorMessage(id, state, `${toolName}: unknown task_id '${id}'.`);
  }
  return null;
}

// ─── cancel_tasks ───────────────────────────────────────────────

const cancelTasksSchema: JsonSchema = {
  type: 'object',
  properties: {
    task_ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'Generated tsk_... ids to cancel. Omit when all=true.',
    },
    all: {
      type: 'boolean',
      description: 'When true, cancel every non-terminal task in the current list.',
    },
    reason: {
      type: 'string',
      description: 'Optional short reason stored on each cancelled task result.',
    },
  },
  additionalProperties: false,
} as unknown as JsonSchema;

export const cancelTasks: CoderTool = {
  name: 'cancel_tasks',
  description:
    'Cancel tasks in the current task list. Pending/failed/interrupted/running tasks become skipped with a cancellation result; done tasks are left untouched.',
  source: 'native',
  parameters: cancelTasksSchema,
  handler: async (args, ctx): Promise<ToolResult> => {
    const runner = ctx.runner;
    if (!runner) return err('cancel_tasks requires runner context');
    const state = ctx.getTasksState?.();
    if (!state) return err('cancel_tasks: no task list found. Call submit_tasks first.');

    const all = args.all === true;
    const explicitIds = parseTaskIds(args.task_ids);
    if (!all && explicitIds.length === 0) return err('cancel_tasks: provide task_ids or all=true.');
    const selectedIds = all
      ? state.tasks.filter((t) => t.status !== 'done' && t.status !== 'skipped').map((t) => t.id)
      : explicitIds;
    const knownError = validateKnownTaskIds(state, selectedIds, 'cancel_tasks');
    if (knownError) return err(knownError);

    const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : 'Cancelled by cancel_tasks.';
    const finishedAt = new Date().toISOString();
    const changed: string[] = [];
    for (const taskId of selectedIds) {
      const task = state.tasks.find((t) => t.id === taskId);
      if (!task || task.status === 'done' || task.status === 'skipped') continue;
      if (runner.currentTaskScopeId() === taskId) runner.endTaskScope();
      const result = { summary: reason, files_modified: [], errors: reason };
      const updated = ctx.updateTaskStatus?.(taskId, {
        status: 'skipped',
        finished_at: finishedAt,
        result,
      });
      if (!updated) return err(`cancel_tasks: failed to persist cancellation for '${taskId}'.`);
      runner.emit('task_finished', { task_id: taskId, status: 'skipped', result, finished_at: finishedAt });
      changed.push(taskId);
    }

    if (changed.length === 0) return ok('cancel_tasks: nothing changed; selected tasks were already terminal.');
    runner.emit('task_updated', { task_id: '__task_list__', patch: {} });
    return ok(`cancel_tasks: cancelled ${changed.length} task(s): ${changed.join(', ')}`);
  },
};

// ─── delete_tasks ───────────────────────────────────────────────

const deleteTasksSchema: JsonSchema = {
  type: 'object',
  properties: {
    task_ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'Generated tsk_... ids to delete from the current list. Omit when all=true.',
    },
    all: {
      type: 'boolean',
      description: 'When true, delete every task from the current task list.',
    },
    force_running: {
      type: 'boolean',
      description: 'When true, also delete running tasks and close the active inline task scope if it matches. Default false.',
    },
  },
  additionalProperties: false,
} as unknown as JsonSchema;

export const deleteTasks: CoderTool = {
  name: 'delete_tasks',
  description:
    'Delete tasks from the current task list. This removes them from persisted state and strips dependencies pointing at them; use cancel_tasks when you want an audit trail.',
  source: 'native',
  parameters: deleteTasksSchema,
  handler: async (args, ctx): Promise<ToolResult> => {
    const runner = ctx.runner;
    if (!runner) return err('delete_tasks requires runner context');
    const state = ctx.getTasksState?.();
    if (!state) return err('delete_tasks: no task list found. Call submit_tasks first.');

    const all = args.all === true;
    const explicitIds = parseTaskIds(args.task_ids);
    if (!all && explicitIds.length === 0) return err('delete_tasks: provide task_ids or all=true.');
    const selectedIds = all ? state.tasks.map((t) => t.id) : explicitIds;
    const knownError = validateKnownTaskIds(state, selectedIds, 'delete_tasks');
    if (knownError) return err(knownError);

    const selected = new Set(selectedIds);
    const running = state.tasks.filter((t) => selected.has(t.id) && t.status === 'running');
    if (running.length > 0 && args.force_running !== true) {
      return err(
        `delete_tasks: refusing to delete running task(s): ${running.map((t) => t.id).join(', ')}. ` +
          'Call task_complete/cancel_tasks first, or pass force_running=true if you are deliberately discarding the running scope.',
      );
    }
    if (args.force_running === true) {
      const active = runner.currentTaskScopeId();
      if (active && selected.has(active)) runner.endTaskScope();
    }

    const remaining = state.tasks
      .filter((t) => !selected.has(t.id))
      .map((t) => ({ ...t, depends_on: t.depends_on.filter((dep) => !selected.has(dep)) }));
    const removed = state.tasks.length - remaining.length;
    if (removed === 0) return ok('delete_tasks: nothing changed.');

    const nextState: TasksState = {
      ...state,
      tasks: remaining,
      current_task_id: state.current_task_id && selected.has(state.current_task_id) ? null : state.current_task_id,
    };
    persistTaskList(ctx, nextState);
    emitTaskListUpdated(runner);
    return ok(`delete_tasks: deleted ${removed} task(s). Remaining tasks: ${remaining.length}.`);
  },
};

// ─── archive_task_list ─────────────────────────────────────────

const archiveTaskListSchema: JsonSchema = {
  type: 'object',
  properties: {
    reason: {
      type: 'string',
      description: 'Optional reason for clearing the current task list.',
    },
  },
  additionalProperties: false,
} as unknown as JsonSchema;

export const archiveTaskList: CoderTool = {
  name: 'archive_task_list',
  description:
    'Clear the current task list for this session so the next submit_tasks starts from a clean UI/state surface. Use when abandoning an old round.',
  source: 'native',
  parameters: archiveTaskListSchema,
  handler: async (args, ctx): Promise<ToolResult> => {
    const runner = ctx.runner;
    if (!runner) return err('archive_task_list requires runner context');
    const state = ctx.getTasksState?.();
    if (!state) return ok('archive_task_list: no active task list.');
    const active = runner.currentTaskScopeId();
    if (active) runner.endTaskScope();

    if (ctx.clearTasksState) {
      const okClear = ctx.clearTasksState();
      if (!okClear) return err('archive_task_list: failed to clear persisted task list.');
    } else {
      persistTaskList(ctx, {
        summary: '',
        tasks: [],
        execution_mode: null,
        approved: false,
        current_task_id: null,
      });
    }
    emitTaskListUpdated(runner);
    const reason = typeof args.reason === 'string' && args.reason.trim() ? ` Reason: ${args.reason.trim()}` : '';
    return ok(`archive_task_list: cleared ${state.tasks.length} task(s).${reason}`);
  },
};

// ─── task_complete ──────────────────────────────────────────────

const taskCompleteSchema: JsonSchema = {
  type: 'object',
  properties: {
    task_id: { type: 'string' },
    summary: { type: 'string', description: '≤200 chars: what was done' },
    files_modified: {
      type: 'array',
      items: { type: 'string' },
      description: 'Project-relative paths actually modified during this task.',
    },
    errors: { type: 'string', description: 'Set when the task failed. If absent the task is marked done.' },
  },
  required: ['task_id', 'summary'],
} as unknown as JsonSchema;

export const taskComplete: CoderTool = {
  name: 'task_complete',
  description: maybeTerse(TASK_COMPLETE_DESC),
  source: 'native',
  parameters: taskCompleteSchema,
  handler: async (args, ctx): Promise<ToolResult> => {
    const taskId = String((args as { task_id?: unknown }).task_id ?? '').trim();
    if (!taskId) return err('task_complete: task_id required');
    const summary = String((args as { summary?: unknown }).summary ?? '').trim();
    if (!summary) return err('task_complete: summary required');
    const filesModifiedRaw = (args as { files_modified?: unknown }).files_modified;
    const filesModified = Array.isArray(filesModifiedRaw)
      ? filesModifiedRaw.filter((f): f is string => typeof f === 'string')
      : [];
    const errors = (() => {
      const v = (args as { errors?: unknown }).errors;
      return typeof v === 'string' && v.trim() ? v : undefined;
    })();

    const runner = ctx.runner;
    if (!runner) return err('task_complete requires runner context');
    if (runner.currentTaskScopeId() !== taskId) {
      return err(
        `task_complete: task_id '${taskId}' doesn't match the active scope (${runner.currentTaskScopeId() ?? 'none'}). ` +
          'You can only complete the currently-active inline task.'
      );
    }

    // Validate files_modified ⊆ scope (warning, not error).
    const scopeFiles = runner.currentTaskScopeFiles() ?? [];
    const violations = filesModified.filter((f) => !isPathInsideScope(f, scopeFiles));

    const finishedAt = new Date().toISOString();
    const status = errors ? 'failed' : 'done';
    ctx.updateTaskStatus?.(taskId, {
      status,
      finished_at: finishedAt,
      result: {
        summary,
        files_modified: filesModified,
        errors,
        sandbox_violations: violations.length > 0 ? violations : undefined,
      },
    });
    runner.endTaskScope();
    runner.emit('task_finished', {
      task_id: taskId,
      status,
      result: {
        summary,
        files_modified: filesModified,
        errors,
        sandbox_violations: violations.length > 0 ? violations : undefined,
      },
      finished_at: finishedAt,
    });

    // Find the next pending task with all deps done.
    const state = ctx.getTasksState?.();
    let nextTaskId: string | null = null;
    if (state) {
      for (const t of state.tasks) {
        if (t.status !== 'pending') continue;
        const allDepsDone = t.depends_on.every((d) => {
          const dep = state.tasks.find((x) => x.id === d);
          return dep?.status === 'done' || dep?.status === 'skipped';
        });
        if (allDepsDone) {
          nextTaskId = t.id;
          break;
        }
      }
    }

    const violationLine =
      violations.length > 0
        ? `\n\n⚠️  Sandbox violations: files_modified included paths outside the task scope: [${violations.join(', ')}]. The task was still marked '${status}' but the orchestrator should review.`
        : '';

    return ok(formatTaskCompletedResult(taskId, summary, nextTaskId) + violationLine);
  },
};

// ─── update_task ────────────────────────────────────────────────
//
// Surgical patch for a single task in the persisted state. Lets the agent
// adjust scope (files), retry a failed task, skip a pending one, or rename
// a task without resubmitting the whole list (which would pause for user
// approval and reset version metadata).
//
// Status transitions are restricted: lifecycle states (running/done/failed)
// flow through execute_task / task_complete. update_task only handles the
// "manual nudge" cases: skip, retry, rename, scope tweak.

const ALLOWED_STATUS_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  pending: new Set(['skipped']),
  failed: new Set(['pending', 'skipped']),
  interrupted: new Set(['pending', 'skipped']),
  skipped: new Set(['pending']),
  // Frente D — running/done are owned by `execute_tasks` (subagent
  // dispatch) and `task_complete` (inline scope close). Refuse here.
  running: new Set([]),
  done: new Set([]),
};

const updateTaskSchema: JsonSchema = {
  type: 'object',
  properties: {
    task_id: { type: 'string', description: 'id of the task to patch.' },
    status: {
      type: 'string',
      enum: ['pending', 'skipped'],
      description:
        "New status. Allowed: 'skipped' (drop a pending/failed/interrupted task), 'pending' (retry a failed/interrupted/skipped task). " +
        // Frente D — singular `execute_task` is gone; lifecycle owners are
        // `execute_tasks` (running/done/failed via subagent) and
        // `task_complete` (running/done via inline scope close).
        "running/done/failed transitions are owned by `execute_tasks` / `task_complete` and cannot be set here.",
    },
    files_add: { type: 'array', items: { type: 'string' }, description: 'Add these paths to the task scope.' },
    files_remove: { type: 'array', items: { type: 'string' }, description: 'Remove these paths from the task scope.' },
    title: { type: 'string', description: 'Replace the task title.' },
    description: { type: 'string', description: 'Replace the task description.' },
  },
  required: ['task_id'],
} as unknown as JsonSchema;

export const updateTask: CoderTool = {
  name: 'update_task',
  description:
    'Patch a single task by id without resubmitting the whole list. Use to: skip a task that is no longer relevant, retry a failed/interrupted task, ' +
    'add or remove files from its scope, or rename it. ' +
    // Frente D — `execute_task` is gone; running/done lifecycle now lives
    // inside `execute_tasks` (subagent dispatch) and `task_complete`
    // (inline scope closer).
    'Status transitions other than skip/retry are owned by `execute_tasks` / `task_complete` — call those instead for running/done/failed.',
  source: 'native',
  parameters: updateTaskSchema,
  handler: async (args, ctx): Promise<ToolResult> => {
    const taskId = String((args as { task_id?: unknown }).task_id ?? '').trim();
    if (!taskId) return err('update_task: task_id required');

    const runner = ctx.runner;
    if (!runner) return err('update_task requires runner context');

    const state = ctx.getTasksState?.();
    if (!state) return err('update_task: no task list found. Call submit_tasks first.');

    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) {
      if (looksLikeLegacyTaskId(taskId) || !looksLikeGeneratedTaskId(taskId)) {
        return err(
          `update_task: invalid task_id '${taskId}'. Task ids are generated by submit_tasks and look like 'tsk_...'. ` +
            'Call list_tasks() and pass an exact id from the current task list.',
        );
      }
      return err(buildTaskIdErrorMessage(taskId, state, `update_task: unknown task_id '${taskId}'.`));
    }

    const newStatus = (args as { status?: unknown }).status;
    const filesAddRaw = (args as { files_add?: unknown }).files_add;
    const filesRemoveRaw = (args as { files_remove?: unknown }).files_remove;
    const newTitle = typeof (args as { title?: unknown }).title === 'string' ? String((args as { title: string }).title).trim() : undefined;
    const newDescription = typeof (args as { description?: unknown }).description === 'string' ? String((args as { description: string }).description).trim() : undefined;

    const wantsAnyChange =
      newStatus !== undefined ||
      Array.isArray(filesAddRaw) ||
      Array.isArray(filesRemoveRaw) ||
      (newTitle !== undefined && newTitle.length > 0) ||
      (newDescription !== undefined && newDescription.length > 0);
    if (!wantsAnyChange) {
      return err('update_task: at least one of {status, files_add, files_remove, title, description} must be provided.');
    }

    const patch: Partial<CoderTask> = {};

    if (newStatus !== undefined) {
      if (typeof newStatus !== 'string' || (newStatus !== 'pending' && newStatus !== 'skipped')) {
        return err(`update_task: status must be 'pending' or 'skipped', got '${String(newStatus)}'. ` +
          'For running/done/failed, use `execute_tasks` / `task_complete`.');
      }
      const allowed = ALLOWED_STATUS_TRANSITIONS[task.status] ?? new Set<string>();
      if (!allowed.has(newStatus)) {
        return err(
          `update_task: cannot move task '${taskId}' from '${task.status}' to '${newStatus}'. ` +
            `Allowed transitions from '${task.status}': ${[...allowed].join(', ') || '(none)'}. ` +
            `If the task is running or done, call task_complete or wait for it to finish naturally.`,
        );
      }
      patch.status = newStatus as CoderTask['status'];
    }

    if (Array.isArray(filesAddRaw) || Array.isArray(filesRemoveRaw)) {
      const additions = Array.isArray(filesAddRaw) ? filesAddRaw.filter((f): f is string => typeof f === 'string' && !!f.trim()) : [];
      const removals = new Set(Array.isArray(filesRemoveRaw) ? filesRemoveRaw.filter((f): f is string => typeof f === 'string' && !!f.trim()) : []);
      const next = task.files.filter((f) => !removals.has(f));
      for (const f of additions) {
        if (!next.includes(f)) next.push(f);
      }
      patch.files = next;
    }

    if (newTitle && newTitle !== task.title) patch.title = newTitle;
    if (newDescription && newDescription !== task.description) patch.description = newDescription;

    const updated = ctx.updateTaskStatus?.(taskId, patch);
    if (!updated) return err(`update_task: failed to persist update for '${taskId}'.`);

    // Emit a dedicated event so the dashboard sidebar can refresh immediately
    // — task_started / task_finished are owned by the lifecycle handlers and
    // we don't want to fake one of those.
    runner.emit('task_updated', { task_id: taskId, patch });

    const newTask = updated.tasks.find((t) => t.id === taskId);
    const lines = [`Task '${taskId}' updated.`];
    if (patch.status) lines.push(`  status: ${task.status} → ${newTask?.status}`);
    if (patch.files) lines.push(`  files: [${(newTask?.files ?? []).join(', ')}]`);
    if (patch.title) lines.push(`  title: "${newTask?.title}"`);
    if (patch.description) lines.push(`  description updated`);
    return ok(lines.join('\n'));
  },
};

// Avoid the unused-import linter complaint until Phase 2 needs them.
void extractPathsFromToolArgs;

// ─── task_list (unified front door) ─────────────────────────────
//
// ONE always-on tool that replaces the todos/tasks selection fork. A single
// `gate` field picks intensity; the handler dispatches to the existing,
// well-tested track (todo_write/update_todo) and approve (submit_tasks)
// handlers, which all write the SAME store (`coder_tasks_state`). The legacy
// names stay registered as back-compat aliases (demoted out of bootstrap).

/**
 * Infer the gate when the model omits it: approve-shaped items carry
 * orchestration fields (description/files/kind/depends_on/references/
 * suggested_mode/estimated_complexity/parallel_group); checklist items only
 * carry content/activeForm/status. Default to track (the cheap, no-pause path).
 */
function inferGate(items: unknown): 'track' | 'approve' {
  if (!Array.isArray(items)) return 'track';
  // `title` is a clean approve discriminator — a track TodoItem only ever
  // carries content/activeForm/status, never title. Keep this set in sync with
  // the dashboard's taskListIsApprove (MessageView.tsx) so the rendered card
  // can never disagree with the handler dispatch.
  const APPROVE_FIELDS = [
    'title', 'description', 'files', 'kind', 'depends_on',
    'references', 'suggested_mode', 'estimated_complexity', 'parallel_group',
  ];
  const looksApprove = items.some(
    (it) => it && typeof it === 'object' && APPROVE_FIELDS.some((f) => {
      const v = (it as Record<string, unknown>)[f];
      return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== '';
    }),
  );
  return looksApprove ? 'approve' : 'track';
}

const taskListSchema: JsonSchema = {
  type: 'object',
  properties: {
    gate: {
      type: 'string',
      enum: ['track', 'approve'],
      description:
        "'track' (default) = lightweight checklist, NEVER pauses, no approval — your live progress list. " +
        "'approve' = gated structured task list: pauses for user approval and is the ONLY thing that arms execute_tasks subagent waves (requires 2+ items with files/kind). " +
        'Omit and it is inferred from the item shape.',
    },
    summary: { type: 'string', description: 'For gate:approve — 1-2 line statement of the overall objective.' },
    items: {
      type: 'array',
      description:
        'The full list (replaces the current one). ' +
        'gate:track items = {id?, content, activeForm, status: pending|in_progress|completed}. ' +
        'gate:approve items = {id?, title, description, files, references?, depends_on?, suggested_mode, estimated_complexity, kind?, parallel_group?}.',
      items: { type: 'object' },
    },
    updates: {
      type: 'array',
      description:
        'Checklist patch (gate:track only): atomically flip status / rename existing items by id without re-sending the whole list. ' +
        'Each entry {id, status?, content?, activeForm?}. Prefer this over re-writing `items` for status changes.',
      items: { type: 'object' },
    },
  },
  additionalProperties: false,
} as unknown as JsonSchema;

export const taskList: CoderTool = {
  name: 'task_list',
  description: maybeTerse(TASK_LIST_DESC),
  source: 'native',
  parameters: taskListSchema,
  handler: async (args, ctx): Promise<ToolResult> => {
    // Patch path → track checklist patch (the update_todo flow).
    if (args.updates !== undefined) {
      return updateTodo.handler({ updates: args.updates }, ctx);
    }
    if (args.items === undefined) {
      return err('task_list: provide `items` (the full list) or `updates` (a checklist patch).');
    }
    const gate = args.gate === 'approve' || args.gate === 'track' ? args.gate : inferGate(args.items);
    if (gate === 'approve') {
      return submitTasks.handler({ summary: args.summary, tasks: args.items }, ctx);
    }
    // track → the todo_write flow (no pause).
    return todoWrite.handler({ todos: args.items }, ctx);
  },
};

// Frente D — `executeTask` (singular) intentionally absent: the
// orchestrator `execute_tasks` (plural, wave-based) is the only path
// the model needs. The export still exists below for backwards
// compatibility with callers that import it directly, but it is NOT
// registered in any session.
export const tasksTools: CoderTool[] = [
  taskList,
  submitTasks,
  listTasks,
  cancelTasks,
  deleteTasks,
  archiveTaskList,
  taskComplete,
  updateTask,
];
