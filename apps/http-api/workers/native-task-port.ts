import { nativeToolUseId } from '@mcp/agent-runtime-host';
import { createHash } from 'node:crypto';
import { NATIVE_TASK_MUTATION_TOOLS, parseNativeTasksState, sameNativeTasks, type NativeTaskMutation } from '@mcp/session-storage/native-task-projection.js';
import type { TaskResult, TasksState } from '@mcp/session-storage/session-state-types.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { TaskToolPort, TaskRuntimeEvent } from '@mcp/code-agent/ports/task-tool-port.js';
import { buildTrackState, deriveTodosFromState } from '@mcp/code-agent/tools/task-list-shared.js';
import type { ToolRegistryHostCapabilityExecutorOptions } from '@mcp/code-agent/runtime/tool-registry-host-capability-executor.js';

function taskSummary(text: string, limit = 512): string {
  if (Buffer.byteLength(text) <= limit) return text;
  return Buffer.from(text).subarray(0, limit - 64).toString('utf8') + '\n[Full result in the child transcript and task-run history.]';
}

function compactResult(result: TaskResult): TaskResult {
  const compact = { ...result, summary: taskSummary(result.summary),
    ...(result.errors ? { errors: taskSummary(result.errors) } : {}) };
  if (Buffer.byteLength(JSON.stringify(compact)) <= 768) return compact;
  // JSON escapes can use six bytes per input character. Bound the actual
  // serialized fields as well as ordinary UTF-8, before adding the pointer.
  const bounded = (value: string, bytes: number) => {
    let text = value.slice(0, bytes);
    while (Buffer.byteLength(JSON.stringify(text)) > bytes) text = text.slice(0, Math.floor(text.length / 2));
    return text;
  };
  return { summary: bounded(result.summary, 256) + '\n[Full result and metadata in the child transcript and task-run history.]', files_modified: [],
    ...(result.errors ? { errors: bounded(result.errors, 128) } : {}),
    ...(result.effectOutcome ? { effectOutcome: result.effectOutcome } : {}) };
}

/** Reserve space before any child effect. 128 bounded results and their
 * timestamps/run identities still fit the 192 KiB durable board envelope. */
function assertResultHeadroom(state: TasksState | null): void {
  if (!state) return;
  const definition = { ...state, tasks: state.tasks.map(({ result: _result, started_at: _start,
    finished_at: _finish, mode_used: _mode, task_run_id: _run, ...task }) => task) };
  if (Buffer.byteLength(JSON.stringify(definition)) > 64 * 1024) {
    throw new Error('Native task plan exceeds 64 KiB; split it into smaller plans before execution');
  }
}

/** Board edits commit atomically with their Host result. execute_tasks also
 * owns external child effects; its known failures retain task state, while
 * uncertain/cancelled dispatches require durable child reconciliation. */
export class NativeTaskPort implements TaskToolPort {
  private state: TasksState | null | undefined;
  private pending?: NativeTaskMutation;
  private detachAbort?: () => void;
  private readonly initial: ToolContext['getTasksState'];
  constructor(context: ToolContext, private readonly assertCurrent: () => void,
    private readonly emit?: (event: TaskRuntimeEvent, data: unknown) => void) {
    this.initial = context.getTasksState;
    context.getTasksState = () => this.read();
    context.ports = { ...context.ports, tasks: this };
  }
  private read(): TasksState | null {
    this.assertCurrent();
    if (this.state === undefined) this.state = parseNativeTasksState(this.initial?.() ?? null);
    return parseNativeTasksState(this.state);
  }
  currentScope(): { id: string; files: string[] } | null {
    const state = this.read();
    if (!state?.current_task_id) return null;
    const task = state.tasks.find(t => t.id === state.current_task_id);
    if (!state.approved || !task || task.status !== 'running') throw new Error('Native task scope is not an approved running task');
    return { id: task.id, files: [...task.files] };
  }
  bind(context: ToolContext, name: string): ToolContext {
    const id = context.currentToolUseId;
    const check = () => { this.assertCurrent(); context.signal?.throwIfAborted(); };
    check();
    if (!id) throw new Error('Native task invocation lacks attribution');
    const write = NATIVE_TASK_MUTATION_TOOLS.includes(name);
    if (!write && name !== 'list_tasks') throw new Error('Unsupported native task operation');
    if (write && this.pending) throw new Error('Native task mutation crossed a sequential barrier');
    const expected = this.read();
    if (name === 'execute_tasks') assertResultHeadroom(expected);
    let budgetRound = 0;
    if (write) {
      this.pending = { version: 1, toolUseId: id, toolName: name, expected, next: expected };
      const abort = () => { if (this.pending?.toolUseId === id) this.pending = undefined; };
      context.signal?.addEventListener('abort', abort, { once: true });
      this.detachAbort = () => context.signal?.removeEventListener('abort', abort);
    }
    const read = () => { check(); return parseNativeTasksState(write ? this.pendingFor(id).next : this.read()); };
    const stage = (state: TasksState | null) => {
      check(); if (!write) throw new Error('Read-only task invocation attempted a mutation');
      assertResultHeadroom(state);
      this.pendingFor(id).next = parseNativeTasksState(state);
    };
    return { ...context,
      getTasksState: read,
      recordTasks: (_reviewId, state) => stage(state),
      resolveTasks: verdict => {
        const state = read(); if (!state) throw new Error('Native task approval lacks a proposal');
        stage({ ...state, approved: verdict.approved, tasks: verdict.tasks ?? state.tasks,
          execution_mode: verdict.execution_mode ?? state.execution_mode });
      },
      updateTaskStatus: (taskId, patch) => {
        const state = read(); if (!state?.tasks.some(t => t.id === taskId)) return null;
        // Full child output is already durable; duplicating it for every task
        // can overflow the Host result and lose an otherwise completed batch.
        if ((name === 'execute_tasks' || name === 'task_complete') && patch.result) patch = { ...patch, result: compactResult(patch.result) };
        stage({ ...state, tasks: state.tasks.map(t => t.id === taskId ? { ...t, ...patch, id: taskId } : t) });
        return read();
      },
      clearTasksState: () => { stage(null); return true; },
      taskRuntime: {
        get currentTodos() { return deriveTodosFromState(read()); },
        setTodos: todos => stage(buildTrackState(todos)),
        currentTaskScopeId: () => read()?.current_task_id ?? null,
        currentTaskScopeFiles: () => { const s = read(); return s?.tasks.find(t => t.id === s.current_task_id)?.files ?? null; },
        endTaskScope: () => { const s = read(); if (s) stage({ ...s, current_task_id: null }); },
        beginTaskScope: scope => {
          const state = read(), task = state?.tasks.find(t => t.id === scope.id);
          if (!state?.approved || !task || task.status !== 'running' || JSON.stringify(task.files) !== JSON.stringify(scope.files)) {
            throw new Error('Native inline scope must match its approved running task');
          }
          stage({ ...state, current_task_id: scope.id });
        },
        markTasksApproved: check,
        // Board edits publish through the confirmed journal. Orchestration
        // additionally streams progress after its child persistence barriers.
        emit: (event, data) => { check(); if (name === 'execute_tasks' || name === 'task_complete' && event === 'task_run_finished') this.emit?.(event, data); },
        requestBudget: async payload => {
          check(); if (!context.ports?.interactions) throw new Error('Native task budget port unavailable');
          const reviewId = `native-tool:${createHash('sha256').update(JSON.stringify([id, payload.runId, ++budgetRound])).digest('hex')}`;
          const deadline = AbortSignal.timeout(Math.max(1, Math.min(60_000, payload.timeoutMs)));
          const signal = AbortSignal.any([deadline, ...(context.signal ? [context.signal] : [])]);
          try {
            return await context.ports.interactions.request({ kind: 'budget_request', payload: { id: reviewId,
              ask_id: reviewId, run_id: payload.runId, spent: payload.spent, cap: payload.cap,
              estimated: payload.estimated, options: payload.options } }, signal);
          } catch (cause) {
            context.signal?.throwIfAborted(); if (deadline.aborted) return 'cancel_pending'; throw cause;
          }
        },
        requestTasks: payload => {
          check(); if (!context.ports?.interactions) throw new Error('Native task review port unavailable');
          return context.ports.interactions.request({ kind: 'tasks_posted', payload: { ...payload, id } }, context.signal);
        },
      },
    };
  }
  private pendingFor(id: string): NativeTaskMutation {
    if (!this.pending || this.pending.toolUseId !== id) throw new Error('Native task invocation no longer owns its state');
    return this.pending;
  }
  result(input: Parameters<NonNullable<ToolRegistryHostCapabilityExecutorOptions['commitResult']>>[0]): NativeTaskMutation | undefined {
    if (!NATIVE_TASK_MUTATION_TOOLS.includes(input.toolName)) return undefined;
    this.assertCurrent();
    const pending = this.pending;
    this.pending = undefined;
    this.detachAbort?.(); this.detachAbort = undefined;
    // Validation failures have no mutation. Once task execution is bound, a
    // confirmed failure still commits its task statuses and child references.
    if (input.result.isError && (input.toolName !== 'execute_tasks' || !pending)) return undefined;
    const id = nativeToolUseId(input.request.identity.attemptId, input.request.providerOperationId, input.request.toolUseId);
    if (!pending || pending.toolUseId !== id || pending.toolName !== input.toolName
      || !sameNativeTasks(this.read(), pending.expected)) throw new Error('Successful native task lacks its attributed mutation');
    this.state = parseNativeTasksState(pending.next);
    return pending;
  }
}
