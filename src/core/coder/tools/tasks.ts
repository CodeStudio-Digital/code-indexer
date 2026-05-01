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
import type { CoderTool, ToolResult, JsonSchema } from '../core/tool.js';
import { ok, err } from '../core/tool.js';
import type {
  CoderTask,
  TaskExecutionMode,
  TaskReference,
  TasksState,
} from '../sessions/types.js';
import { extractPathsFromToolArgs, isPathInsideScope } from '../core/runner.js';
import { runImplementSubagent } from './implement-subagent.js';
import {
  SUBMIT_TASKS_DESC,
  EXECUTE_TASK_DESC,
  TASK_COMPLETE_DESC,
  maybeTerse,
} from './descriptions.js';

// ─── Validation helpers ─────────────────────────────────────────

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

function validateTaskInput(raw: unknown, idx: number): CoderTask | string {
  if (!raw || typeof raw !== 'object') return `tasks[${idx}] must be an object`;
  const o = raw as Record<string, unknown>;
  const id = String(o.id ?? '').trim();
  if (!id) return `tasks[${idx}].id required`;
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

  if (suggestedMode === 'subagent' && files.length === 0) {
    return `tasks[${idx}] (${id}): subagent tasks must declare at least one file in scope`;
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
    status: 'pending',
  };
}

export function validateTasksInput(raw: unknown): { summary: string; tasks: CoderTask[] } | string {
  if (!raw || typeof raw !== 'object') return 'input must be an object';
  const o = raw as Record<string, unknown>;
  const summary = String(o.summary ?? '').trim();
  if (!summary) return 'summary required';
  if (!Array.isArray(o.tasks) || o.tasks.length === 0) return 'tasks must be a non-empty array';
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
  return { summary, tasks };
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
  lines.push('Now call execute_task once per task in order. After each task call task_complete (inline) or wait for the subagent result (subagent mode).');
  return lines.join('\n');
}

export function formatTasksRejectedResult(feedback?: string): string {
  return `Task list rejected by user.${feedback ? ` Feedback: ${feedback}` : ''} Revise the tasks and call submit_tasks again.`;
}

export function formatTaskCompletedResult(taskId: string, summary: string, nextTaskId: string | null): string {
  if (nextTaskId) {
    return `Task ${taskId} marked as done. Summary: ${summary}\n\nNext task ready: ${nextTaskId}. Call execute_task with task_id="${nextTaskId}" to continue.`;
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
          id: { type: 'string', description: "Stable id like 'task_1'. Referenced by depends_on of other tasks." },
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
            description: 'ids of tasks that must finish before this one starts.',
          },
          suggested_mode: {
            type: 'string',
            enum: ['inline', 'subagent'],
            description: "'inline' = execute in the parent context (good for tasks needing prior history). 'subagent' = isolated subagent with only this task's files+references (token-cheap).",
          },
          estimated_complexity: { type: 'string', enum: ['small', 'medium', 'large'] },
        },
        required: ['id', 'title', 'description', 'files', 'suggested_mode', 'estimated_complexity'],
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

    const toolUseId = `tasks_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const initialState: TasksState = {
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
      ctx.resolveTasks?.({
        approved: true,
        tasks: parsed.tasks,
        execution_mode: parsed.execution_mode ?? 'inline',
      });
      runner.markTasksApproved();
      const finalState = ctx.getTasksState?.() ?? {
        ...initialState,
        approved: true,
        execution_mode: parsed.execution_mode ?? 'inline',
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
    if (!task) return err(`execute_task: unknown task_id '${taskId}'`);
    const retryable: ReadonlySet<string> = new Set(['pending', 'interrupted', 'failed']);
    if (!retryable.has(task.status)) {
      return err(
        `execute_task: task ${taskId} status is '${task.status}', expected one of: ${[...retryable].join(', ')}.`
      );
    }
    // Check dependencies
    for (const dep of task.depends_on) {
      const depTask = state.tasks.find((t) => t.id === dep);
      if (!depTask) return err(`execute_task: task ${taskId} depends on unknown '${dep}'`);
      if (depTask.status !== 'done' && depTask.status !== 'skipped') {
        return err(`execute_task: task ${taskId} depends on '${dep}' which is '${depTask.status}'.`);
      }
    }

    const effectiveMode = resolveEffectiveMode(task, state.execution_mode, overrideMode);

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

// Avoid the unused-import linter complaint until Phase 2 needs them.
void extractPathsFromToolArgs;

export const tasksTools: CoderTool[] = [submitTasks, executeTask, taskComplete];
