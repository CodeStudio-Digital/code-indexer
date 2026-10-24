/**
 * Build the per-turn `<active-context>` block injected as the trailing user
 * message before each provider.chat() call when `agentLoopV2` is enabled.
 *
 * Why a trailing user-role message and not an edit to the system prompt?
 *   The system prompt is the prefix-cache anchor. Mutating it every turn
 *   would invalidate the cache and explode token cost. The trailing message
 *   already changes turn over turn (new tool_result), so adding a synthetic
 *   user-content block on top of it costs nothing in cache terms.
 *
 * The block is REGENERATED every turn from live state — the runner's
 * `currentTodos`, the session's persisted goal, and the active task scope
 * (if execute_task is in flight). It is never persisted to `this.messages`.
 */
import type { TasksState } from '@mcp/session-storage/session-state-types.js';
import type { GoalStatus } from '@mcp/code-agent/core/tool.js';
import { type TodoItem, effectiveGate } from '@mcp/code-agent/tools/task-list-shared.js';

export interface GoalSnapshot {
  text: string;
  status: GoalStatus;
  budgetTokens?: number | null;
  completionNote?: string | null;
}

export interface ActiveContextInputs {
  todos?: TodoItem[];
  goal?: GoalSnapshot | null;
  tasksState?: TasksState | null;
  /** Hard cap in characters, applied after assembly. Truncates todo lines first. */
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 4000;

/**
 * State-transition guidance for an active goal, adapted from Codex's
 * `goals/continuation.md` + `goals/budget_limit.md` into a single compact line
 * (our `<active-context>` ships every turn, so a full page would tax every
 * turn). Only when `in_progress`: reinforce continuation fidelity — keep the
 * whole objective, don't declare completion early — with the soft-budget
 * wrap-up folded in. 'complete' goals need no guidance (the note says it all).
 */
function goalGuidanceLine(goal: GoalSnapshot): string | null {
  if (goal.status !== 'in_progress') return null;
  let line =
    'goal_guidance: keep the FULL objective intact — do not redefine success as a smaller or easier subset, and ending a turn does not require shrinking it. Mark complete only when the requested end state is true and verified (never just because the session is long).';
  if (goal.budgetTokens && goal.budgetTokens > 0) {
    line += ` Soft token budget ~${goal.budgetTokens}: as you approach it, wrap up (summarize progress + next step) instead of starting new substantive work.`;
  }
  return line;
}

/**
 * Render the <active-context> block. Returns null if there is nothing
 * worth saying (no goal, no todos, no active task) — callers should skip
 * injection in that case to keep the prompt lean.
 */
export function buildActiveContextBlock(input: ActiveContextInputs): string | null {
  const todos = input.todos ?? [];
  const goal = input.goal ?? null;
  const state = input.tasksState ?? null;
  const cap = input.maxChars ?? DEFAULT_MAX_CHARS;

  // Only an APPROVE list has an execute_tasks "active task" scope. A track
  // checklist's in-progress item is rendered under `todos:` instead, so never
  // surface it as active_task (that would double-render and confuse the model).
  const activeTask = state && effectiveGate(state) === 'approve'
    ? state.tasks.find((t) => t.status === 'running') ?? null
    : null;

  const hasContent = !!goal || todos.length > 0 || !!activeTask;
  if (!hasContent) return null;

  // Header = everything except the todo body. Built as its own array so the
  // truncation path can measure/keep it without fragile positional indexing
  // (goal guidance can insert a line between goal and active_task).
  const headerLines: string[] = ['<active-context>'];

  if (goal) {
    const note = goal.completionNote ? ` — ${goal.completionNote}` : '';
    headerLines.push(`goal: ${goal.text} (status=${goal.status}${note})`);
    const guidance = goalGuidanceLine(goal);
    if (guidance) headerLines.push(guidance);
  }

  if (activeTask) {
    const files = activeTask.files.length
      ? ` — files: [${activeTask.files.join(', ')}]`
      : '';
    headerLines.push(`active_task: ${activeTask.id} "${activeTask.title}"${files}`);
  }

  const todoItemLines = todos.map((t) => {
    const label = t.status === 'in_progress' ? t.activeForm : t.content;
    const idTag = t.id ? `(id=${t.id}) ` : '';
    return `  - [${t.status}] ${idTag}${label}`;
  });

  const bodyLines = todoItemLines.length > 0 ? ['todos:', ...todoItemLines] : [];
  let block = [...headerLines, ...bodyLines, '</active-context>'].join('\n');

  if (block.length > cap) {
    // Truncate todo body, keep header (open + goal + guidance + active_task) intact.
    const headerSize = headerLines.join('\n').length;
    const budget = cap - headerSize - '\n</active-context>'.length - '\ntodos:'.length;
    const kept: string[] = [];
    let used = 0;
    for (const line of todoItemLines) {
      if (used + line.length + 1 > budget) break;
      kept.push(line);
      used += line.length + 1;
    }
    const dropped = todoItemLines.length - kept.length;
    if (dropped > 0) kept.push(`  ... ${dropped} more truncated`);
    block = [...headerLines, 'todos:', ...kept, '</active-context>'].join('\n');
  }

  return block;
}
