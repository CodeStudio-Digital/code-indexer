import type { ToolContext } from '../core/tool.js';
import type { RunnerEvents } from '../core/runner/events.js';
import type { AgentTreeEvent } from '../ports/agent-tree-port.js';

/** Native runs expose progress through their admitted tree owner, without
 * manufacturing a legacy runner just for UI publication. */
export function emitSubagentEvent<K extends AgentTreeEvent>(ctx: ToolContext,
  event: K, ...args: Parameters<RunnerEvents[K]>): void {
  if (ctx.runtimeGeneration === 'rust_v1') {
    const tree = ctx.ports?.agentTree;
    if (!tree || tree.ownerAgentRunId !== ctx.controlPlaneParentAgentRunId) throw new Error('Native agent event has no tree owner');
    tree.emit?.(event, args[0]);
  } else ctx.runner?.emit(event, ...args);
}
