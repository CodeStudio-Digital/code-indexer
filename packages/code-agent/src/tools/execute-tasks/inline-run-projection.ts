import type { SessionId } from '@mcp/session-storage';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import type { CoderTask } from '@mcp/session-storage/session-state-types.js';
import type { ToolContext } from '../../core/tool.js';

/** Idempotent display projection. It never authorizes execution or retries. */
export function inlineRunProjection(store: FsSessionStore, sessionId: SessionId): NonNullable<ToolContext['completeInlineTaskRun']> {
  return async task => {
    if (!task.task_run_id) return null;
    if (task.mode_used !== 'inline' || !['done', 'failed'].includes(task.status) || !task.result || !task.finished_at) {
      throw new Error('Inline task-run completion requires a finished owned scope');
    }
    const saved = await store.getTaskRunWithItems(sessionId, task.task_run_id);
    const item = saved?.items.find(value => value.task_id === task.id && value.attempt === 0);
    if (!saved || !item) throw new Error('Inline task-run projection has no matching run item');
    await store.upsertTaskRunItem({ ...item, session_id: sessionId, status: task.status,
      finished_at: task.finished_at, summary: task.result.summary, error: task.result.errors ?? null });
    const latest = new Map<string, typeof item>();
    for (const value of saved.items) {
      const current = latest.get(value.task_id);
      if (!current || value.attempt >= current.attempt) latest.set(value.task_id, value.task_id === task.id ? { ...value, status: task.status } : value);
    }
    if ([...latest.values()].some(value => value.status === 'running' || value.status === 'pending')) return null;
    const total_usage = saved.items.reduce((usage, value) => ({ input_tokens: usage.input_tokens + value.input_tokens,
      output_tokens: usage.output_tokens + value.output_tokens }), { input_tokens: 0, output_tokens: 0 });
    const status = [...latest.values()].some(value => value.status === 'failed' || value.status === 'interrupted') ? 'failed' : 'completed';
    await store.updateTaskRun(sessionId, task.task_run_id, { status, finished_at: task.finished_at,
      total_input_tokens: total_usage.input_tokens, total_output_tokens: total_usage.output_tokens });
    return { run_id: task.task_run_id, status, total_usage, finished_at: task.finished_at };
  };
}
