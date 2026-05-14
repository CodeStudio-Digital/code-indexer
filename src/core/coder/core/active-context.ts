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
import type { TodoItem } from '../tools/todo.js';
import type { TasksState } from '../sessions/types.js';

export interface GoalSnapshot {
  text: string;
  status: 'in_progress' | 'complete';
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
 * Render the <active-context> block. Returns null if there is nothing
 * worth saying (no goal, no todos, no active task) — callers should skip
 * injection in that case to keep the prompt lean.
 */
export function buildActiveContextBlock(input: ActiveContextInputs): string | null {
  const todos = input.todos ?? [];
  const goal = input.goal ?? null;
  const state = input.tasksState ?? null;
  const cap = input.maxChars ?? DEFAULT_MAX_CHARS;

  const activeTask = state
    ? state.tasks.find((t) => t.status === 'running') ?? null
    : null;

  const hasContent = !!goal || todos.length > 0 || !!activeTask;
  if (!hasContent) return null;

  const lines: string[] = ['<active-context>'];

  if (goal) {
    const note = goal.completionNote ? ` — ${goal.completionNote}` : '';
    lines.push(`goal: ${goal.text} (status=${goal.status}${note})`);
  }

  if (activeTask) {
    const files = activeTask.files.length
      ? ` — files: [${activeTask.files.join(', ')}]`
      : '';
    lines.push(`active_task: ${activeTask.id} "${activeTask.title}"${files}`);
  }

  if (todos.length > 0) {
    lines.push('todos:');
    for (const t of todos) {
      const label = t.status === 'in_progress' ? t.activeForm : t.content;
      const idTag = t.id ? `(id=${t.id}) ` : '';
      lines.push(`  - [${t.status}] ${idTag}${label}`);
    }
  }

  lines.push('</active-context>');
  let block = lines.join('\n');

  if (block.length > cap) {
    // Truncate todo body, keep header/goal/active_task lines intact.
    const headerLines: string[] = ['<active-context>'];
    if (goal) headerLines.push(lines[1]);
    if (activeTask) headerLines.push(goal ? lines[2] : lines[1]);
    const headerSize = headerLines.join('\n').length;
    const budget = cap - headerSize - '\n</active-context>'.length - '\ntodos:'.length;
    const todoLines = todos.map((t) => {
      const label = t.status === 'in_progress' ? t.activeForm : t.content;
      const idTag = t.id ? `(id=${t.id}) ` : '';
      return `  - [${t.status}] ${idTag}${label}`;
    });
    const kept: string[] = [];
    let used = 0;
    for (const line of todoLines) {
      if (used + line.length + 1 > budget) break;
      kept.push(line);
      used += line.length + 1;
    }
    const dropped = todoLines.length - kept.length;
    if (dropped > 0) kept.push(`  ... ${dropped} more truncated`);
    block = [...headerLines, 'todos:', ...kept, '</active-context>'].join('\n');
  }

  return block;
}
