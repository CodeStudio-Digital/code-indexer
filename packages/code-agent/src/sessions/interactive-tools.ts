import type { AgentMessage } from '@mcp/provider-sdk';

/**
 * Interactive tools whose pending `tool_use` the resume path can restore as a
 * live card after a reopen, refresh or restart.
 *
 * Single source of truth for BOTH sides of the contract: the writer that
 * checkpoints the parked turn (`checkpointPendingTurn`) and the reader that
 * finds it again (`findPendingInteraction` in the HTTP layer). They used to be
 * two hand-maintained lists, and `decision_gate` was in the reader only — so a
 * decision card existed solely in the live buffer and any reload lost it, with
 * `POST /decide` then answering 404.
 *
 * Deliberately NOT here: a PermissionGate pause or an execute_tasks budget ask.
 * Checkpointing those would persist a dangling non-interactive `tool_use` that
 * renders as a stuck "running" spinner with no way to approve it.
 */
export const RESUMABLE_INTERACTIVE_TOOLS = new Set([
  'submit_plan',
  'submit_tasks',
  // The canonical bootstrap route to the gated pause: task_list(gate:'approve')
  // dispatches to submitTasks' waitForUserInput and renders a real approve card.
  'task_list',
  'ask_user',
  'submit_spec',
  'submit_specification_to_master',
  'decision_gate',
]);

export type ResumableInteractiveTool =
  | 'submit_plan'
  | 'submit_tasks'
  | 'task_list'
  | 'ask_user'
  | 'submit_spec'
  | 'submit_specification_to_master'
  | 'decision_gate';

export function isResumableInteractiveTool(name: string): name is ResumableInteractiveTool {
  return RESUMABLE_INTERACTIVE_TOOLS.has(name);
}

/** True when the message parks on a prompt the resume path can restore. */
export function hasResumableInteractiveToolUse(msg: AgentMessage): boolean {
  return Array.isArray(msg.content)
    && msg.content.some((b) => b.type === 'tool_use' && RESUMABLE_INTERACTIVE_TOOLS.has(b.name));
}
