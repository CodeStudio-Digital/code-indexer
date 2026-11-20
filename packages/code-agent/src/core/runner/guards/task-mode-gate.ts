/**
 * Task-mode gate — enforces the user's `execution_mode` choice on the
 * approved task list.
 *
 * Problem solved: when the user approves a task list with
 * `execution_mode = 'all-subagent'`, the intent is clear — every mutating
 * change should be carried out by an isolated implement subagent (via
 * `execute_task({task_id})`). But the LLM often ignores the post-approval
 * instruction and starts calling `edit_file` / `write_file` / `run_command`
 * directly, making the user's mode choice invisible.
 *
 * This gate runs on every tool dispatch (in `executing-dispatch.ts`,
 * BEFORE the tuple-hash check). It refuses mutating tools whose execution
 * would bypass the task pipeline. The refusal text points the model at
 * `execute_task` so the next turn course-corrects.
 *
 * Pure: same inputs → same verdict. Same family as `checkDupCall` and
 * `checkDoomLoop` — fits naturally into the dispatch gate chain.
 */
import type { TaskExecutionMode } from '@mcp/session-storage/session-state-types.js';

export interface TaskGateState {
  approved: boolean;
  execution_mode: TaskExecutionMode | null;
  tasks: ReadonlyArray<{ id: string; status: string }>;
}

export interface TaskGateInputs {
  /** Snapshot of the persisted tasks state. Null when no list is active. */
  tasksState: TaskGateState | null;
  /** Tool the agent is about to dispatch. */
  toolName: string;
  /**
   * Effective "mutates" flag for this tool. Caller resolves with the same
   * rule as the plan/spec gate: `tool.mutates ?? (source === 'mcp_external')`.
   */
  toolMutates: boolean;
}

/**
 * Tool names that are PART of the task workflow itself — they must
 * always pass the gate even when the all-subagent constraint is active.
 */
const WORKFLOW_TOOLS: ReadonlySet<string> = new Set([
  'execute_tasks',  // PR 3 — wave-based orchestrator, the sole dispatch entry
  // Frente D — `execute_task` (singular) is no longer registered; the gate
  // doesn't need to keep an entry for a name the model can't produce.
  'task_complete',
  'list_tasks',
  'cancel_tasks',
  'delete_tasks',
  'archive_task_list',
  'update_task',
  'task_list',
  // Investigation / orchestration tools — fine to call between tasks.
  'spawn_agent',
  'workflow',
  'ask_user',
  'submit_plan',
  'find_tools',
  'expand_toolset',
]);

/**
 * Decide whether the tool call should be refused. Returns the refusal
 * text when blocked, or `null` when allowed.
 */
export function checkTaskModeGate(inp: TaskGateInputs): string | null {
  const state = inp.tasksState;
  // No task list, or not approved yet → workflow doesn't apply.
  if (!state || !state.approved) return null;
  // Only the all-subagent mode is opinionated. Inline/smart/per-task all
  // permit direct tool calls — the model's discretion drives those.
  if (state.execution_mode !== 'all-subagent') return null;
  // Workflow-internal tools must pass.
  if (WORKFLOW_TOOLS.has(inp.toolName)) return null;
  // Read-only tools are always fine — they don't bypass anything.
  if (!inp.toolMutates) return null;
  // If every task is terminal, the workflow is done — the constraint
  // lifts (post-pipeline cleanup is the agent's discretion).
  const allTerminal = state.tasks.every((t) => t.status === 'done' || t.status === 'skipped');
  if (allTerminal) return null;

  const pending = state.tasks
    .filter((t) => t.status !== 'done' && t.status !== 'skipped')
    .map((t) => t.id);
  const nextId = pending[0] ?? '<next>';
  return (
    `[task-mode-gate: this session was approved with execution_mode="all-subagent". ` +
    `Every mutating change MUST go through an isolated implement subagent. ` +
    `Call \`execute_tasks()\` (next pending: ${nextId}) instead of \`${inp.toolName}\`.\n` +
    `Pending tasks: ${pending.join(', ')}.]`
  );
}
