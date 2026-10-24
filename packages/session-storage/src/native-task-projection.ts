import { isDeepStrictEqual } from 'node:util';
import type { CoderTask, TasksState } from './session-state-types.js';

export const NATIVE_TASK_MUTATION_TOOLS = Object.freeze([
  'todo_write', 'update_todo', 'task_list', 'submit_tasks', 'update_task',
  'cancel_tasks', 'delete_tasks', 'archive_task_list', 'task_complete', 'execute_tasks',
]);
// Expected + next remain below the 1 MiB Host envelope, including task results.
export const NATIVE_TASK_STATE_MAX_BYTES = 192 * 1024;
const statuses = ['pending', 'running', 'done', 'failed', 'skipped', 'interrupted'];
const modes = ['inline', 'all-subagent', 'smart', 'per-task'];
const fail = (): never => { throw new Error('Invalid or oversized native task state'); };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 8192): value is string {
  return typeof value === 'string' && value.length <= max;
}
function strings(value: unknown, max = 128): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(v => text(v, 4096));
}
function task(value: unknown): CoderTask {
  const t = record(value);
  if (!text(t.id, 128) || !t.id || !text(t.title) || !text(t.description)
    || !strings(t.files) || !strings(t.depends_on) || !Array.isArray(t.references) || t.references.length > 128
    || !['inline', 'subagent'].includes(t.suggested_mode as string)
    || !['small', 'medium', 'large'].includes(t.estimated_complexity as string)
    || !statuses.includes(t.status as string)) return fail();
  for (const field of ['agent_profile', 'content', 'activeForm', 'parallel_group', 'reject_reason']) {
    if (t[field] !== undefined && !text(t[field])) return fail();
  }
  for (const field of ['started_at', 'finished_at']) {
    if (t[field] !== undefined && (!text(t[field], 32) || !Number.isFinite(Date.parse(t[field] as string)))) return fail();
  }
  if (t.kind !== undefined && !['investigate', 'implement', 'verify'].includes(t.kind as string)
    || t.mode_used !== undefined && !['inline', 'subagent'].includes(t.mode_used as string)
    || t.force_run !== undefined && typeof t.force_run !== 'boolean') return fail();
  if (t.task_run_id !== undefined && (typeof t.task_run_id !== 'string'
    || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(t.task_run_id))) return fail();
  for (const value of t.references) {
    const r = record(value);
    if (!['symbol', 'snippet', 'file', 'doc'].includes(r.type as string) || !text(r.value)) return fail();
    if (r.file !== undefined && !text(r.file, 4096) || r.note !== undefined && !text(r.note)) return fail();
    if (r.lines !== undefined && !text(r.lines, 128)) return fail();
  }
  if (t.result !== undefined) {
    const r = record(t.result);
    if (r.effectOutcome !== undefined && r.effectOutcome !== 'unknown') return fail();
    if (!text(r.summary) || !strings(r.files_modified)
      || r.errors !== undefined && !text(r.errors) || r.sandbox_violations !== undefined && !strings(r.sandbox_violations)) return fail();
    if (r.subagent_usage !== undefined && !Object.values(record(r.subagent_usage))
      .every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return fail();
  }
  return t as unknown as CoderTask;
}

/** Bound both result snapshots well below the 1 MiB Host envelope. The clone
 * prevents callers from changing an already staged or projected state. */
export function parseNativeTasksState(value: unknown): TasksState | null {
  if (value === null) return null;
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded, 'utf8') > NATIVE_TASK_STATE_MAX_BYTES) return fail();
  const s = record(JSON.parse(encoded));
  if (!text(s.summary) || !Array.isArray(s.tasks) || s.tasks.length > 128
    || s.gate !== undefined && !['track', 'approve'].includes(s.gate as string)
    || typeof s.approved !== 'boolean' || s.execution_mode !== null && !modes.includes(s.execution_mode as string)
    || s.current_task_id !== null && !text(s.current_task_id, 128)) return fail();
  const tasks = s.tasks.map(task);
  const byId = new Map(tasks.map(t => [t.id, t]));
  if (byId.size !== tasks.length || s.current_task_id !== null && !byId.has(s.current_task_id as string)) return fail();
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (t: CoderTask): void => {
    if (visiting.has(t.id)) return fail();
    if (visited.has(t.id)) return;
    visiting.add(t.id);
    for (const dep of t.depends_on) { const parent = byId.get(dep); if (!parent) return fail(); visit(parent); }
    visiting.delete(t.id); visited.add(t.id);
  };
  tasks.forEach(visit);
  return s as unknown as TasksState;
}
export const sameNativeTasks = (a: TasksState | null, b: TasksState | null): boolean => isDeepStrictEqual(a, b);

export interface NativeTaskMutation {
  version: 1; toolUseId: string; toolName: string;
  expected: TasksState | null; next: TasksState | null;
}
export function parseNativeTaskMutation(value: unknown, id: string, name: string): NativeTaskMutation {
  const m = record(value);
  if (m.version !== 1 || m.toolUseId !== id || m.toolName !== name || !NATIVE_TASK_MUTATION_TOOLS.includes(name)) {
    throw new Error('Native task attribution diverged');
  }
  return { version: 1, toolUseId: id, toolName: name,
    expected: parseNativeTasksState(m.expected), next: parseNativeTasksState(m.next) };
}

/** Only consume verified result/terminal pairs. Undefined delegates to the
 * legacy board; null is a durable clear and must never resurrect that board. */
export class NativeTaskProjection {
  private state: TasksState | null | undefined;
  apply(value: unknown, id: string, name: string, isError: boolean): void {
    if (value === undefined) {
      if (!isError && NATIVE_TASK_MUTATION_TOOLS.includes(name)) throw new Error('Successful native task lacks a mutation');
      return;
    }
    // A known failed orchestration still commits completed/failed task states.
    // Uncertain effects never reach this boundary: the Host emits no result.
    if (isError && name !== 'execute_tasks') throw new Error('Failed native task carries a mutation');
    const m = parseNativeTaskMutation(value, id, name);
    if (this.state !== undefined && !sameNativeTasks(this.state, m.expected)) throw new Error('Native task history is discontinuous');
    this.state = m.next;
  }
  get value(): TasksState | null | undefined {
    return this.state === undefined ? undefined : parseNativeTasksState(this.state);
  }
}
