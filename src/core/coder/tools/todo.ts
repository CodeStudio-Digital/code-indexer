import type { CoderTool, ToolContext, ToolResult } from '../core/tool.js';
import { ok, err } from '../core/tool.js';

/**
 * todo_write — lightweight, user-visible checklist distinct from submit_tasks.
 *
 * Why have this AND submit_tasks?
 *   - submit_tasks PAUSES execution waiting for user approval of a structured
 *     task list with curated file/reference scopes. Heavy, gated.
 *   - todo_write does NOT pause. It's the agent's way of broadcasting "here's
 *     what I'm doing, here's where I am" during a long run. The dashboard
 *     renders the list in a sidebar and updates it in real time.
 *
 * This matches the distinction Claude Code itself draws between TodoWriteTool
 * (user-facing imperative checklist) and its internal Task* tool family.
 *
 * Rule: exactly one todo should be `in_progress` at a time. The tool enforces
 * this soft rule — warning, not error, since the model sometimes needs a
 * brief overlap during transitions.
 */

export interface TodoItem {
  /** Imperative form — what the agent is going to do ("Run tests"). */
  content: string;
  /** Present continuous — what shows up in the UI while it runs ("Running tests"). */
  activeForm: string;
  status: 'pending' | 'in_progress' | 'completed';
}

function validateTodos(raw: unknown): { ok: true; todos: TodoItem[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'todos must be an array' };
  if (raw.length === 0) {
    return { ok: true, todos: [] }; // clearing the list is legal
  }
  if (raw.length > 50) {
    return { ok: false, error: `too many todos (${raw.length}, max 50). Group related items into fewer lines.` };
  }
  const out: TodoItem[] = [];
  const seenContent = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== 'object' || item === null) {
      return { ok: false, error: `todos[${i}] must be an object with {content, activeForm, status}` };
    }
    const obj = item as Record<string, unknown>;
    const content = typeof obj.content === 'string' ? obj.content.trim() : '';
    const activeForm = typeof obj.activeForm === 'string' ? obj.activeForm.trim() : '';
    const status = obj.status;
    if (!content) return { ok: false, error: `todos[${i}].content cannot be empty` };
    if (!activeForm) return { ok: false, error: `todos[${i}].activeForm cannot be empty` };
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
      return { ok: false, error: `todos[${i}].status must be pending|in_progress|completed, got '${String(status)}'` };
    }
    if (seenContent.has(content)) {
      return { ok: false, error: `todos[${i}].content '${content}' is duplicated — merge the duplicates` };
    }
    seenContent.add(content);
    out.push({ content, activeForm, status });
  }
  return { ok: true, todos: out };
}

export const todoWrite: CoderTool = {
  name: 'todo_write',
  description:
    'Maintain a lightweight user-visible checklist of what you are doing in this session. Distinct from submit_tasks — this NEVER pauses.\n' +
    "USE: at the start of any multi-step work to broadcast your plan, then update as you go (flip items to in_progress, then completed).\n" +
    "USE: to add new items mid-run when you discover sub-tasks you didn't anticipate.\n" +
    "USE: to keep the dashboard sidebar informative during long sessions so the user can see where you are without parsing the chat.\n" +
    "DON'T: use for single-step tasks — just do the work.\n" +
    "DON'T: use instead of submit_tasks — submit_tasks is for structured work that needs user APPROVAL before you touch code.\n" +
    "DON'T: mark items as completed until you ACTUALLY finished them.\n" +
    "DON'T: have more than one item in 'in_progress' at a time.\n" +
    'Pass the FULL list each call — it replaces the previous list, it does not merge.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description:
          'The complete, updated checklist. Each item has content (imperative, what you will do), activeForm (present continuous, what shows while running), and status (pending|in_progress|completed). Passing an empty array clears the list.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Imperative form. Example: "Run tests"' },
            activeForm: { type: 'string', description: 'Present continuous. Example: "Running tests"' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
            },
          },
          required: ['content', 'activeForm', 'status'],
        },
      },
    },
    required: ['todos'],
    additionalProperties: false,
  },
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const validation = validateTodos(args.todos);
    if (!validation.ok) return err(validation.error);
    const todos = validation.todos;

    const runner = ctx.runner as unknown as
      | { setTodos?: (t: TodoItem[]) => void; currentTodos?: TodoItem[] }
      | undefined;
    if (!runner || typeof runner.setTodos !== 'function') {
      return err('todo_write requires a runner that supports todo tracking.');
    }

    const inProgress = todos.filter((t) => t.status === 'in_progress');
    const completed = todos.filter((t) => t.status === 'completed').length;
    const pending = todos.filter((t) => t.status === 'pending').length;

    runner.setTodos(todos);

    const warnings: string[] = [];
    if (inProgress.length > 1) {
      warnings.push(
        `WARNING: ${inProgress.length} todos in_progress simultaneously. Keep it to exactly one for clarity.`,
      );
    }

    if (todos.length === 0) {
      return ok('Todo list cleared.');
    }

    const summary = `${todos.length} todo${todos.length === 1 ? '' : 's'}: ${completed} completed, ${inProgress.length} in_progress, ${pending} pending`;
    const lines = todos.map((t) => {
      const marker = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
      const label = t.status === 'in_progress' ? t.activeForm : t.content;
      return `  ${marker} ${label}`;
    });
    return ok([summary, ...lines, ...warnings].join('\n'));
  },
};

export const todoTools: CoderTool[] = [todoWrite];
