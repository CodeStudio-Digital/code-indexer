import { randomUUID } from 'node:crypto';
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';

/**
 * todo_write / update_todo — lightweight, user-visible checklist distinct from submit_tasks.
 *
 * Why have this AND submit_tasks?
 *   - submit_tasks PAUSES execution waiting for user approval of a structured
 *     task list with curated file/reference scopes. Heavy, gated.
 *   - todo_write does NOT pause. It's the agent's way of broadcasting "here's
 *     what I'm doing, here's where I am" during a long run. The dashboard
 *     renders the list in a sidebar and updates it in real time.
 *
 * Each TodoItem carries a stable `id` (8-char hex slice of a UUID v4)
 * generated server-side. The id lets `update_todo` patch a single item
 * (status/content/activeForm) without the agent having to re-send the
 * full list — the previous "Pass the FULL list each call" contract was
 * the root cause of the agent forgetting old items mid-run.
 */

export interface TodoItem {
  /** Stable identifier — referenced by `update_todo` for incremental patches. */
  id: string;
  /** Imperative form — what the agent is going to do ("Run tests"). */
  content: string;
  /** Present continuous — what shows up in the UI while it runs ("Running tests"). */
  activeForm: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * Generate a short, stable id for a todo. 8 hex chars from a UUID v4 — short
 * enough for the agent to copy into update_todo arguments, long enough that
 * collision in a list of 50 items is astronomically unlikely.
 */
export function generateTodoId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

const ID_RE = /^[a-z0-9]{6,32}$/;

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
  const seenIds = new Set<string>();
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

    // Honor caller-supplied id when valid and unique within this list;
    // otherwise mint a fresh one. Keeps update_todo cycles stable across
    // todo_write re-submissions when the agent passes ids back through.
    const rawId = typeof obj.id === 'string' ? obj.id.trim().toLowerCase() : '';
    let id: string;
    if (rawId && ID_RE.test(rawId) && !seenIds.has(rawId)) {
      id = rawId;
    } else {
      id = generateTodoId();
      // Defensive: extremely unlikely, but if collision against existing seen
      // ids, regenerate until unique.
      while (seenIds.has(id)) id = generateTodoId();
    }
    seenIds.add(id);
    out.push({ id, content, activeForm, status });
  }
  return { ok: true, todos: out };
}

// ─── Burst guard for todo_write ────────────────────────────────────────
//
// Mirrors the create_goal burst guard in goal.ts. When the agent reissues
// `todo_write` with the same logical list 3+ times inside 90s without any
// real change in between, we hard-refuse and point them at update_todo.
// Detecting "same logical list" by signature on `content` keeps refining
// (item add/remove/rewrite) legitimate — only true reruns trip the guard.

const WRITE_BURST_BY_RUNNER = new WeakMap<object, { count: number; lastAt: number; lastSig: string }>();
const WRITE_BURST_THRESHOLD = 3;
const WRITE_BURST_WINDOW_MS = 90_000;

function todosSignature(todos: TodoItem[]): string {
  return todos
    .map((t) => `${t.status}:${t.content}`)
    .sort()
    .join('|');
}

function readKey(ctx: ToolContext): object | null {
  return (ctx.runner as unknown as object) ?? null;
}

/**
 * Returns the new burst count after applying the window-reset and
 * signature-change rules. Caller refuses when count exceeds the threshold.
 */
function bumpWriteBurst(ctx: ToolContext, todos: TodoItem[]): { count: number; sig: string } {
  const key = readKey(ctx);
  const sig = todosSignature(todos);
  if (!key) return { count: 0, sig };
  const now = Date.now();
  const prior = WRITE_BURST_BY_RUNNER.get(key);
  if (!prior || now - prior.lastAt > WRITE_BURST_WINDOW_MS || prior.lastSig !== sig) {
    WRITE_BURST_BY_RUNNER.set(key, { count: 1, lastAt: now, lastSig: sig });
    return { count: 1, sig };
  }
  const next = { count: prior.count + 1, lastAt: now, lastSig: sig };
  WRITE_BURST_BY_RUNNER.set(key, next);
  return { count: next.count, sig };
}

/** Test-only hook: clear the burst counter for a runner key. */
export function _resetWriteBurstForKey(key: object): void {
  WRITE_BURST_BY_RUNNER.delete(key);
}

// ─── todo_write ────────────────────────────────────────────────────────

function formatTodoLine(t: TodoItem): string {
  const marker = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
  const label = t.status === 'in_progress' ? t.activeForm : t.content;
  return `  ${marker} (id=${t.id}) ${label}`;
}

function formatSummary(todos: TodoItem[]): string {
  const inProgress = todos.filter((t) => t.status === 'in_progress').length;
  const completed = todos.filter((t) => t.status === 'completed').length;
  const pending = todos.filter((t) => t.status === 'pending').length;
  return `${todos.length} todo${todos.length === 1 ? '' : 's'}: ${completed} completed, ${inProgress} in_progress, ${pending} pending`;
}

export const todoWrite: CoderTool = {
  name: 'todo_write',
  description:
    'Replace the active todo list. Lightweight, user-visible checklist that NEVER pauses (distinct from submit_tasks, which gates on approval).\n' +
    'Pass the FULL list each call — it replaces the previous list, it does not merge.\n' +
    '\n' +
    'PREFER `update_todo` for status changes on existing items. Only call `todo_write` when adding/removing items or starting a fresh list.\n' +
    '\n' +
    'Each item is assigned a stable `id` (8-char hex). Pass the same id back on re-submit to preserve identity; omit `id` for new items and the server mints one.\n' +
    '\n' +
    'RULES:\n' +
    '1. Do not call this tool repeatedly without making real progress on at least one task between calls. Progress means a tool result, file change, or verified observation. Re-writing the same list is counterproductive — use update_todo instead.\n' +
    '2. Update statuses progressively as work happens — flip items to in_progress BEFORE starting, to completed IMMEDIATELY after finishing. Do not batch completions at the end.\n' +
    '3. Do not jump an item from pending directly to completed: always set it to in_progress first.\n' +
    '4. Exactly ONE item in_progress at a time.\n' +
    '5. Reconcile the list before stopping the session: every item must end as completed or be removed. Never end a session with pending/in_progress items unless you state in your final message exactly why they are non-applicable.\n' +
    '\n' +
    'WHEN TO USE: multi-step work (3+ distinct steps), tasks with logical phases or dependencies, or when the user gave a list of things to do.\n' +
    "WHEN NOT TO USE: single-step work, simple questions, conversational replies, or when the user gave very specific one-shot instructions — just do the work.\n" +
    'If you find yourself unable to advance any task with your available tools, inform the user about what is blocking you instead of replanning.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description:
          'The complete, updated checklist. Each item has content (imperative, what you will do), activeForm (present continuous, what shows while running), status (pending|in_progress|completed), and an optional id (preserved across re-submits when supplied).',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Optional stable id (8-char hex). Pass back the id from a previous call to preserve identity; omit for new items.',
            },
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

    // Burst guard: refuse repeated rewrites of the same logical list.
    // Empty-list (clear) and signature changes both reset the counter — only
    // identical re-submissions count.
    if (todos.length > 0) {
      const burst = bumpWriteBurst(ctx, todos);
      if (burst.count > WRITE_BURST_THRESHOLD) {
        const ids = todos.map((t) => t.id).join(', ');
        return err(
          `Refused: todo_write called ${burst.count} times in the last ${Math.round(WRITE_BURST_WINDOW_MS / 1000)}s ` +
            `with the same list and no intervening progress. ` +
            `Use update_todo({id: "...", status: "completed"}) to flip a single item instead of re-sending the whole list. ` +
            `Current ids: ${ids}.`,
        );
      }
    } else {
      // Clearing resets the burst tracker entirely.
      const key = readKey(ctx);
      if (key) WRITE_BURST_BY_RUNNER.delete(key);
    }

    runner.setTodos(todos);

    const inProgress = todos.filter((t) => t.status === 'in_progress');
    const warnings: string[] = [];
    if (inProgress.length > 1) {
      warnings.push(
        `WARNING: ${inProgress.length} todos in_progress simultaneously. Keep it to exactly one for clarity.`,
      );
    }

    if (todos.length === 0) {
      return ok('Todo list cleared.');
    }

    const lines = todos.map(formatTodoLine);
    return ok([formatSummary(todos), ...lines, ...warnings].join('\n'));
  },
};

// ─── update_todo ───────────────────────────────────────────────────────

export const updateTodo: CoderTool = {
  name: 'update_todo',
  description:
    'Patch a single todo by id. Use this to flip status (pending → in_progress → completed) or rename content/activeForm without re-sending the whole list. ' +
    'Get ids from the most recent todo_write result or from the <active-context> block.\n' +
    '\n' +
    'At least one of {status, content, activeForm} is required. Other items in the list are left untouched.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The id of the todo to patch (from todo_write or <active-context>).' },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed'],
        description: 'New status for this item.',
      },
      content: { type: 'string', description: 'Replacement imperative-form text (rare; prefer rewriting the whole list via todo_write).' },
      activeForm: { type: 'string', description: 'Replacement present-continuous text.' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const id = typeof args.id === 'string' ? args.id.trim().toLowerCase() : '';
    if (!id) return err('update_todo: id is required');

    const status = args.status;
    const newContent = typeof args.content === 'string' ? args.content.trim() : undefined;
    const newActiveForm = typeof args.activeForm === 'string' ? args.activeForm.trim() : undefined;
    const hasStatus = status === 'pending' || status === 'in_progress' || status === 'completed';
    // Validate status first — reject an explicitly bad value before falling
    // through to the "no fields provided" check, otherwise the user gets a
    // misleading "at least one of …" error when they really passed a bad status.
    if (status !== undefined && !hasStatus) {
      return err(`update_todo: status must be pending|in_progress|completed, got '${String(status)}'`);
    }
    if (!hasStatus && !newContent && !newActiveForm) {
      return err('update_todo: at least one of {status, content, activeForm} must be provided');
    }

    const runner = ctx.runner as unknown as
      | { setTodos?: (t: TodoItem[]) => void; currentTodos?: TodoItem[] }
      | undefined;
    if (!runner || typeof runner.setTodos !== 'function') {
      return err('update_todo requires a runner that supports todo tracking.');
    }

    const current = Array.isArray(runner.currentTodos) ? runner.currentTodos : [];
    if (current.length === 0) {
      return err('update_todo: no active todo list — call todo_write first to create one.');
    }

    const idx = current.findIndex((t) => t.id === id);
    if (idx < 0) {
      const knownIds = current.map((t) => t.id).join(', ');
      return err(
        `update_todo: id '${id}' not found. Known ids: ${knownIds}. ` +
          `Pass an exact id from the most recent todo_write result.`,
      );
    }

    const next: TodoItem[] = current.map((t, i) => (i === idx ? { ...t } : { ...t }));
    const target = next[idx];
    if (hasStatus) target.status = status as TodoItem['status'];
    if (newContent) target.content = newContent;
    if (newActiveForm) target.activeForm = newActiveForm;

    runner.setTodos(next);

    const inProgress = next.filter((t) => t.status === 'in_progress');
    const warnings: string[] = [];
    if (inProgress.length > 1) {
      warnings.push(
        `WARNING: ${inProgress.length} todos in_progress simultaneously. Keep it to exactly one for clarity.`,
      );
    }

    const lines = next.map(formatTodoLine);
    return ok([formatSummary(next), ...lines, ...warnings].join('\n'));
  },
};

export const todoTools: CoderTool[] = [todoWrite, updateTodo];
