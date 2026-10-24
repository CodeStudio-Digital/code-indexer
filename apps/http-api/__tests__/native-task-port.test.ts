import { expect, it, vi } from 'vitest';
import { nativeToolUseId } from '@mcp/agent-runtime-host';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { tasksTools, validateTasksInput } from '@mcp/code-agent/tools/tasks.js';
import { todoWrite, updateTodo } from '@mcp/code-agent/tools/todo.js';
import { NativeTaskProjection, parseNativeTasksState } from '@mcp/session-storage/native-task-projection.js';
import type { TasksState } from '@mcp/session-storage/session-state-types.js';
import { NativeTaskPort } from '../workers/native-task-port.js';
import { NativeCoderInteractions } from '../sse/native-coder-interactions.js';
import { NativeInteractiveToolPort } from '../workers/native-interactive-tool-port.js';
import { nativeCoderWorkspaceAccess } from '../workers/native-coder-catalog.js';

function harness(initial: TasksState | null = null) {
  const controller = new AbortController();
  const legacyWrite = vi.fn(() => { throw new Error('Second writer must not be used'); });
  const context = { cwd: process.cwd(), signal: controller.signal, planMode: true,
    getTasksState: () => initial, recordTasks: legacyWrite } as unknown as ToolContext;
  let revoked = false, serial = 0;
  const port = new NativeTaskPort(context, () => { if (revoked) throw new Error('revoked'); });
  const registry = new ToolRegistry();
  for (const tool of [...tasksTools, todoWrite, updateTodo]) registry.register(tool);
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const request = { identity: { attemptId: 'attempt' }, providerOperationId: 'provider', toolUseId: `call-${++serial}` };
    const result = await registry.invoke(name, args, { ...context,
      currentToolUseId: nativeToolUseId('attempt', 'provider', request.toolUseId) });
    return { request, toolName: name, result } as Parameters<NativeTaskPort['result']>[0];
  };
  const commit = async (name: string, args: Record<string, unknown>) => {
    const input = await invoke(name, args);
    expect(input.result.isError, input.result.content).not.toBe(true);
    return port.result(input)!;
  };
  return { context, controller, legacyWrite, port, invoke, commit, revoke: () => { revoked = true; } };
}
const todos = [
  { id: 'aaa11111', content: 'Read source', activeForm: 'Reading source', status: 'in_progress' },
  { id: 'bbb22222', content: 'Run tests', activeForm: 'Running tests', status: 'pending' },
];
const proposal = { summary: 'Review and verify', tasks: [
  { id: 'read', title: 'Read', description: 'Inspect code' },
  { id: 'test', title: 'Test', description: 'Run checks', depends_on: ['read'] },
] };

it('keeps long child summaries out of the bounded task board', async () => {
  const h = harness();
  h.context.ports!.interactions = { request: async () => '{"approved":true}', approvePlan() {}, approveSpec() {}, agentId: 'plan', specMode: false };
  const proposed = await h.commit('submit_tasks', proposal), task = proposed.next!.tasks[0];
  const bound = h.port.bind({ ...h.context, currentToolUseId: 'native-tool:large-summary' }, 'execute_tasks');
  await bound.updateTaskStatus!(task.id, { status: 'done', result: { summary: '漢字'.repeat(25_000), files_modified: [] } });
  const summary = bound.getTasksState!()!.tasks[0].result!.summary;
  expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(512); expect(summary).toContain('child transcript');
});

it.each(['漢字', '\u0000'] as const)('reserves result space and bounds escaped metadata across 128 tasks (%j)', text => {
  const initial: TasksState = { summary: 'Large board', gate: 'approve', approved: true,
    execution_mode: 'all-subagent', current_task_id: null, tasks: Array.from({ length: 128 }, (_, i) => ({
      id: `task-${i}`, title: 'Task', description: 'Read and verify', files: [], depends_on: [], references: [],
      suggested_mode: 'subagent', estimated_complexity: 'small', status: 'pending',
    })) };
  const h = harness(initial), bound = h.port.bind({ ...h.context, currentToolUseId: 'large-board' }, 'execute_tasks');
  for (const task of initial.tasks) bound.updateTaskStatus!(task.id, { status: 'done',
    started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
    task_run_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', mode_used: 'subagent',
    result: { summary: text.repeat(10_000), errors: text.repeat(10_000),
      files_modified: Array.from({ length: 128 }, () => 'path'.repeat(100)), sandbox_violations: ['outside/'.repeat(1000)] } });
  expect(bound.getTasksState!()!.tasks.every(t => t.status === 'done')).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(bound.getTasksState!()))).toBeLessThan(192 * 1024);
  const oversized = harness({ ...initial, tasks: initial.tasks.map(t => ({ ...t, description: 'x'.repeat(600) })) });
  expect(() => oversized.port.bind({ ...oversized.context, currentToolUseId: 'oversized' }, 'execute_tasks')).toThrow('64 KiB');
});

it('stages an approved inline scope and commits a known orchestration failure without losing task state', () => {
  const initial: TasksState = { gate: 'approve', summary: 'Execute', approved: true, execution_mode: 'inline', current_task_id: null,
    tasks: [{ id: 'tsk_inline', title: 'Task', description: 'Task', files: ['src/a.ts'], depends_on: [], references: [],
      suggested_mode: 'inline', estimated_complexity: 'small', status: 'running' }] };
  const h = harness(initial), request = { identity: { attemptId: 'attempt' }, providerOperationId: 'provider', toolUseId: 'execute' };
  const bound = h.port.bind({ ...h.context, currentToolUseId: nativeToolUseId('attempt', 'provider', 'execute') }, 'execute_tasks');
  expect(() => bound.taskRuntime!.beginTaskScope!({ id: 'tsk_inline', files: ['foreign'] })).toThrow('approved');
  bound.taskRuntime!.beginTaskScope!({ id: 'tsk_inline', files: ['src/a.ts'] });
  expect(h.port.currentScope()).toBeNull();
  const input = { request, toolName: 'execute_tasks', result: { content: 'Earlier task failed; inline task ready', isError: true } } as Parameters<NativeTaskPort['result']>[0];
  const mutation = h.port.result(input)!;
  expect(h.port.currentScope()?.id).toBe('tsk_inline');
  const projection = new NativeTaskProjection(); projection.apply(mutation, mutation.toolUseId, 'execute_tasks', true);
  expect(projection.value).toEqual(h.context.getTasksState!());
  expect(h.port.result(input)).toBeUndefined(); // Validation error before a second bind.
});

it.each(['answer', 'timeout', 'cancel'] as const)('owns budget review identity and cleans its slot on %s', async action => {
  const h = harness(), slots = new NativeCoderInteractions(h.controller.signal);
  const emit = vi.fn((name, payload) => {
    expect(name).toBe('budget_request'); expect(payload.ask_id).toBe(payload.id);
    expect(slots.pendingDefaultId).toBe(payload.id);
    if (action === 'answer') void slots.provideInput(payload.id, 'continue');
    if (action === 'cancel') h.controller.abort();
  });
  h.context.ports!.interactions = new NativeInteractiveToolPort('task', false, slots, emit, () => {});
  const bound = h.port.bind({ ...h.context, currentToolUseId: 'native-tool:budget-test' }, 'execute_tasks');
  const waiting = bound.taskRuntime!.requestBudget!({ runId: 'run', spent: 20, cap: 10, estimated: 2,
    options: ['continue', 'cancel_pending'], timeoutMs: action === 'timeout' ? 10 : 1000 });
  if (action === 'cancel') await expect(waiting).rejects.toThrow();
  else expect(await waiting).toBe(action === 'answer' ? 'continue' : 'cancel_pending');
  expect(slots.isWaiting).toBe(false); expect(emit).toHaveBeenCalledOnce(); slots.close();
});

it.each([false, true])('completes only its owned active scope with a confirmed journal mutation (failed=%s)', async failed => {
  const initial: TasksState = { gate: 'approve', summary: 'Resume an active task', execution_mode: 'inline', approved: true,
    current_task_id: 'tsk_inline', tasks: [{ id: 'tsk_inline', title: 'Task', description: 'Task', files: ['src/a.ts'],
      depends_on: [], references: [], suggested_mode: 'inline', estimated_complexity: 'small', status: 'running', mode_used: 'inline' }] };
  const h = harness(initial);
  expect(h.port.currentScope()).toEqual({ id: 'tsk_inline', files: ['src/a.ts'] });
  const foreign = await h.invoke('task_complete', { task_id: 'foreign', summary: 'Wrong scope' });
  expect(foreign.result.isError).toBe(true); expect(h.port.result(foreign)).toBeUndefined();
  const input = await h.invoke('task_complete', { task_id: 'tsk_inline', summary: 'Verified task', files_modified: ['src/a.ts'],
    ...(failed ? { errors: 'Verification failed' } : {}) });
  expect(input.result.isError, input.result.content).not.toBe(true);
  expect(h.port.currentScope()?.id).toBe('tsk_inline');
  const mutation = h.port.result(input)!;
  expect(h.port.currentScope()).toBeNull(); expect(h.context.getTasksState!()?.tasks[0]?.status).toBe(failed ? 'failed' : 'done');
  const projection = new NativeTaskProjection(); projection.apply(mutation, mutation.toolUseId, mutation.toolName, false);
  expect(projection.value).toEqual(h.context.getTasksState!()); expect(initial.current_task_id).toBe('tsk_inline');
  expect((await h.invoke('task_complete', { task_id: 'tsk_inline', summary: 'Duplicate completion' })).result.isError).toBe(true);
  expect(h.legacyWrite).not.toHaveBeenCalled();
});

it('commits checklist aliases once, atomically patches, and replays a durable clear', async () => {
  const h = harness(), projection = new NativeTaskProjection();
  const input = await h.invoke('task_list', { gate: 'track', items: todos });
  expect(input.result.isError, input.result.content).not.toBe(true);
  expect(h.context.getTasksState!()).toBeNull();
  const first = h.port.result(input)!;
  expect(first.toolName).toBe('task_list');
  projection.apply(first, first.toolUseId, first.toolName, false);
  expect(h.context.getTasksState!()?.tasks[0]?.status).toBe('running');
  const bad = await h.invoke('update_todo', { updates: [{ id: 'aaa11111', status: 'completed' }, { id: 'missing', status: 'in_progress' }] });
  expect(bad.result.isError).toBe(true); expect(h.port.result(bad)).toBeUndefined();
  expect(h.context.getTasksState!()?.tasks[0]?.status).toBe('running');
  const update = await h.commit('task_list', { updates: [{ id: 'aaa11111', status: 'completed' }, { id: 'bbb22222', status: 'in_progress' }] });
  projection.apply(update, update.toolUseId, update.toolName, false);
  expect(projection.value?.tasks.map(t => t.status)).toEqual(['done', 'running']);
  const clear = await h.commit('archive_task_list', {});
  projection.apply(clear, clear.toolUseId, clear.toolName, false);
  expect(projection.value).toBeNull(); expect(h.context.getTasksState!()).toBeNull();
  expect(h.legacyWrite).not.toHaveBeenCalled();
});

it('rejects stale attribution, revoked ownership and edits after per-tool cancellation', async () => {
  const h = harness();
  const input = await h.invoke('todo_write', { todos });
  expect(() => h.port.result({ ...input, request: { ...input.request, toolUseId: 'foreign' } })).toThrow('attributed');
  expect(h.context.getTasksState!()).toBeNull();
  const local = new AbortController();
  const bound = h.port.bind({ ...h.context, signal: local.signal, currentToolUseId: 'native-tool:cancel' }, 'todo_write');
  bound.taskRuntime!.setTodos(todos as never);
  local.abort();
  expect(() => bound.taskRuntime!.setTodos([])).toThrow();
  expect(h.context.getTasksState!()).toBeNull();
  await h.commit('todo_write', { todos });
  h.revoke();
  expect(() => h.context.getTasksState!()).toThrow('revoked');
});

it('registers approval before publication and carries only the confirmed edited board', async () => {
  const h = harness(), slots = new NativeCoderInteractions(h.controller.signal);
  const emit = vi.fn((_name, payload) => {
    expect(slots.pendingDefaultId).toBe(payload.id);
    expect(payload.tool_use_id).toBe(payload.id);
    expect(h.context.getTasksState!()).toBeNull();
    void slots.provideInput(payload.id, JSON.stringify({ approved: true, execution_mode: 'inline' }));
  });
  h.context.ports!.interactions = new NativeInteractiveToolPort('plan', false, slots, emit, () => {});
  const mutation = await h.commit('submit_tasks', proposal);
  expect(mutation.next?.approved).toBe(true);
  expect(mutation.next?.tasks[1]?.depends_on).toEqual([mutation.next?.tasks[0]?.id]);
  expect(emit).toHaveBeenCalledOnce(); expect(slots.isWaiting).toBe(false);
  expect(h.legacyWrite).not.toHaveBeenCalled(); slots.close();
});

it('discards invalid review edits and cancels the exact pending slot on local timeout', async () => {
  const h = harness(), slots = new NativeCoderInteractions(h.controller.signal);
  let cancel = false;
  h.context.ports!.interactions = new NativeInteractiveToolPort('plan', false, slots, (_name, payload) => {
    if (cancel) h.controller.abort();
    else void slots.provideInput((payload as { id: string }).id, JSON.stringify({ approved: true, tasks: [{}] }));
  }, () => {});
  const bad = await h.invoke('submit_tasks', proposal);
  expect(bad.result.isError).toBe(true); expect(h.port.result(bad)).toBeUndefined();
  expect(h.context.getTasksState!()).toBeNull();
  cancel = true;
  const aborted = await h.invoke('submit_tasks', proposal);
  expect(aborted.result.isError).toBe(true); expect(slots.isWaiting).toBe(false);
  expect(h.port.result(aborted)).toBeUndefined();
  expect(h.context.getTasksState!()).toBeNull(); slots.close();
});

it('preserves dependency integrity across edit, cancellation, deletion and restart', async () => {
  const h = harness();
  h.context.ports!.interactions = { request: async () => '{"approved":true}', approvePlan() {}, approveSpec() {}, agentId: 'plan', specMode: false };
  const initial = await h.commit('submit_tasks', proposal);
  const [first, second] = initial.next!.tasks;
  const edited = await h.commit('update_task', { task_id: first!.id, title: 'Read carefully', files_add: ['src/main.ts'] });
  expect(edited.next!.tasks[0]!.files).toEqual(['src/main.ts']);
  expect((await h.invoke('list_tasks', {})).result.content).toContain('Read carefully');
  const cancelled = await h.commit('cancel_tasks', { task_ids: [first!.id, second!.id] });
  expect(cancelled.next!.tasks.map(t => t.status)).toEqual(['skipped', 'skipped']);
  const deleted = await h.commit('delete_tasks', { task_ids: [first!.id] });
  expect(deleted.next!.tasks).toHaveLength(1); expect(deleted.next!.tasks[0]!.depends_on).toEqual([]);
  const projection = new NativeTaskProjection();
  for (const m of [initial, edited, cancelled, deleted]) projection.apply(m, m.toolUseId, m.toolName, false);
  expect(projection.value).toEqual(h.context.getTasksState!());
  expect(() => projection.apply(edited, edited.toolUseId, edited.toolName, false)).toThrow('discontinuous');
});

it('bounds repeated native approvals by the attempt port across distinct tool contexts', async () => {
  const h = harness();
  const request = vi.fn(async () => '{"approved":true}');
  h.context.ports!.interactions = { request, approvePlan() {}, approveSpec() {}, agentId: 'plan', specMode: false };
  for (let i = 0; i < 3; i++) await h.commit('submit_tasks', proposal);
  const repeated = await h.invoke('submit_tasks', proposal);
  expect(repeated.result.isError).toBe(true);
  expect(repeated.result.content).toContain('Refused: submit_tasks');
  expect(h.port.result(repeated)).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(3);
  const other = harness();
  other.context.ports!.interactions = h.context.ports!.interactions;
  await other.commit('submit_tasks', proposal);
  expect(request).toHaveBeenCalledTimes(4);
});

it('bounds task graphs, rejects dependency cycles and does not let reads mutate snapshots', async () => {
  expect(validateTasksInput({ ...proposal, tasks: [{ ...proposal.tasks[0], depends_on: ['test'] }, proposal.tasks[1]] })).toContain('cycles');
  expect(validateTasksInput({ ...proposal, summary: {} })).toContain('summary required');
  const h = harness(); await h.commit('todo_write', { todos });
  const state = h.context.getTasksState!()!;
  state.tasks[0]!.title = 'foreign';
  expect(h.context.getTasksState!()!.tasks[0]!.title).toBe('Read source');
  expect(() => parseNativeTasksState({ ...state, summary: 'x'.repeat(8193) })).toThrow('oversized');
  expect(() => parseNativeTasksState({ ...state, tasks: [...state.tasks, state.tasks[0]] })).toThrow();
  expect(() => new NativeTaskProjection().apply(undefined, 'call', 'todo_write', false)).toThrow('lacks');
});

it.each([...tasksTools, todoWrite, updateTodo])(
  'requires the native task journal contract for $name', tool => {
    expect(nativeCoderWorkspaceAccess([tool])).toBe(tool.name === 'list_tasks' ? 'read_only' : 'exclusive_write');
    expect(() => nativeCoderWorkspaceAccess([{ ...tool, parallelSafe: !tool.parallelSafe }])).toThrow('journal contract');
  });
