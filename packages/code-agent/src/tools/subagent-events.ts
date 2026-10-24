import type { ToolContext } from '../core/tool.js';
import type { RunnerEvents } from '../core/runner/events.js';
type AgentTreeEvent = 'agents_group_start' | 'agent_progress' | 'agents_group_end'
  | 'workflow_run_started' | 'workflow_step_update' | 'workflow_run_finished';

/** Publish child progress through the owning TypeScript runner. */
export function emitSubagentEvent<K extends AgentTreeEvent>(ctx: ToolContext,
  event: K, ...args: Parameters<RunnerEvents[K]>): void {
  ctx.runner?.emit(event, ...args);
}
