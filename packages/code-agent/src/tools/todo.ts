import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { type TodoItem, generateTodoId, effectiveGate } from '@mcp/code-agent/tools/task-list-shared.js';

/**
 * todo_write / update_todo — the `track` (lightweight checklist) gate of the
 * unified `task_list` tool. Kept as registered back-compat aliases after the
 * todos/tasks merge; `task_list({gate:'track', ...})` is the canonical name.
 *
 *   - track (these) does NOT pause. It broadcasts "here's what I'm doing" — the
 *     dashboard renders it as a live sidebar checklist.
 *   - approve (`submit_tasks` / `task_list({gate:'approve'})`) PAUSES for user
 *     approval and is the only thing that arms `execute_tasks`.
 *
 * Both gates write the same session-local task record,
 * so a checklist and an approve list can never coexist as parallel lists.
 *
 * Each TodoItem carries a stable `id` (8-char hex). The id lets `update_todo`
 * patch a single item without re-sending the full list.
 */

// Re-exported so existing importers (active-context, dashboard typing) keep
// resolving `TodoItem`/`generateTodoId` from this module after the move.
export { generateTodoId };
export type { TodoItem };

const ID_RE = /^[a-z0-9]{6,32}$/;

/**
 * Data-safety guard for the track gate. Refuse a checklist write while an
 * APPROVE list is still active (has pending/running tasks): the single store
 * holds one list per session, so a track write would otherwise clobber an
 * in-flight approved task list. Returns an actionable redirect, or null to
 * proceed. (Terminal approve lists — all done/skipped/failed/interrupted — are
 * fine to replace with a checklist.)
 */
function guardTrackWriteOverApprove(ctx: ToolContext): string | null {
  const state = ctx.getTasksState?.() ?? null;
  if (!state || state.tasks.length === 0) return null;
  if (effectiveGate(state) !== 'approve') return null;
  const hasActive = state.tasks.some((t) => t.status === 'pending' || t.status === 'running');
  if (!hasActive) return null;
  return (
    'Refused: an approved task list is still active, so a lightweight checklist would overwrite it. ' +
    'Continue the approved list with execute_tasks, or update the existing task if its scope changed.'
  );
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
    if (content.length > 8192 || activeForm.length > 8192) return { ok: false, error: `todos[${i}] text exceeds 8192 characters` };
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
// Avoid repeated checklist writes. When the agent reissues
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
  return ((ctx.runner) as unknown as object) ?? null;
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
    '2. Update statuses progressively as work happens — flip items to in_progress BEFORE starting, to completed IMMEDIATELY after finishing. Do not batch completions at the end. Completing the current item and starting the next is ONE update_todo call (`updates: [...]`), not two.\n' +
    '3. Do not jump an item from pending directly to completed: always set it to in_progress first.\n' +
    '4. Exactly ONE item in_progress at a time.\n' +
    '5. Bookkeeping rides along: emit todo_write/update_todo in the SAME assistant turn as your next work tool call (parallel tool calls are supported) — never spend a turn on checklist updates alone.\n' +
    '6. Reconcile the list before stopping the session: every item must end as completed or be removed. Never end a session with pending/in_progress items unless you state in your final message exactly why they are non-applicable.\n' +
    '\n' +
    'WHEN TO USE: multi-step work (3+ distinct steps), tasks with logical phases or dependencies, or when the user gave a list of things to do.\n' +
    "WHEN NOT TO USE: single-step work, simple questions, conversational replies, or when the user gave very specific one-shot instructions — just do the work.\n" +
    'If you find yourself unable to advance any task with your available tools, inform the user about what is blocking you instead of replanning.',
  source: 'native',
  mutates: false, parallelSafe: false, riskLevel: 'read', effectBoundary: 'control', executionClass: 'control',
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
    ctx.signal?.throwIfAborted();
    const guard = guardTrackWriteOverApprove(ctx);
    if (guard) return err(guard);
    const validation = validateTodos(args.todos);
    if (!validation.ok) return err(validation.error);
    const todos = validation.todos;

    const runner = (ctx.runner) as unknown as
      | { setTodos?: (t: TodoItem[]) => void | Promise<void>; currentTodos?: TodoItem[] }
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
            `Use update_todo — single {id, status} or batch updates: [{id, status}, …] — instead of re-sending the whole list. ` +
            `Current ids: ${ids}.`,
        );
      }
    } else {
      // Clearing resets the burst tracker entirely.
      const key = readKey(ctx);
      if (key) WRITE_BURST_BY_RUNNER.delete(key);
    }

    await runner.setTodos(todos);

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

interface TodoPatch {
  id: string;
  status?: TodoItem['status'];
  content?: string;
  activeForm?: string;
}

const MAX_PATCHES_PER_CALL = 10;

/**
 * Parse and validate one patch (from the top-level single form or one
 * `updates[]` entry). `label` names the source in error messages.
 */
function parsePatch(raw: Record<string, unknown>, label: string): { ok: true; patch: TodoPatch } | { ok: false; error: string } {
  const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : '';
  if (!id) return { ok: false, error: `update_todo: ${label}.id is required` };

  const status = raw.status;
  const content = typeof raw.content === 'string' ? raw.content.trim() : undefined;
  const activeForm = typeof raw.activeForm === 'string' ? raw.activeForm.trim() : undefined;
  if (content && content.length > 8192 || activeForm && activeForm.length > 8192) {
    return { ok: false, error: `update_todo: ${label} text exceeds 8192 characters` };
  }
  const hasStatus = status === 'pending' || status === 'in_progress' || status === 'completed';
  // Validate status first — reject an explicitly bad value before falling
  // through to the "no fields provided" check, otherwise the caller gets a
  // misleading "at least one of …" error when they really passed a bad status.
  if (status !== undefined && !hasStatus) {
    return { ok: false, error: `update_todo: ${label}.status must be pending|in_progress|completed, got '${String(status)}'` };
  }
  if (!hasStatus && !content && !activeForm) {
    return { ok: false, error: `update_todo: ${label} needs at least one of {status, content, activeForm}` };
  }
  return {
    ok: true,
    patch: {
      id,
      ...(hasStatus ? { status: status as TodoItem['status'] } : {}),
      ...(content ? { content } : {}),
      ...(activeForm ? { activeForm } : {}),
    },
  };
}

export const updateTodo: CoderTool = {
  name: 'update_todo',
  description:
    'Patch one or more todos by id in a SINGLE call, without re-sending the whole list.\n' +
    'Flips status (pending → in_progress → completed) or renames content/activeForm. ' +
    'Get ids from the most recent todo_write result or from the <active-context> block.\n' +
    '\n' +
    'Single patch: pass {id, status?, content?, activeForm?} at the top level.\n' +
    'Several patches: pass `updates: [{id, status?, ...}, ...]` (max ' + MAX_PATCHES_PER_CALL + ') — validated and applied ATOMICALLY: one bad id rejects the whole call and nothing changes.\n' +
    '\n' +
    'Finishing one item and starting the next is ONE call, not two:\n' +
    '  updates: [{id: "a1b2c3d4", status: "completed"}, {id: "e5f6a7b8", status: "in_progress"}]\n' +
    '\n' +
    'Do not spend a turn on bookkeeping alone — emit update_todo in the SAME assistant turn as your next work tool call (parallel tool calls are supported).\n' +
    'At least one of {status, content, activeForm} is required per patch. Items not referenced are left untouched.',
  source: 'native',
  mutates: false, parallelSafe: false, riskLevel: 'read', effectBoundary: 'control', executionClass: 'control',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Id of the todo to patch (single form). For 2+ changes use `updates` instead.' },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed'],
        description: 'New status for this item.',
      },
      content: { type: 'string', description: 'Replacement imperative-form text (rare; prefer rewriting the whole list via todo_write).' },
      activeForm: { type: 'string', description: 'Replacement present-continuous text.' },
      updates: {
        type: 'array',
        description:
          'Batch form: several patches applied atomically in one call. Each entry: {id (required), status?, content?, activeForm?}. ' +
          'Use for the complete-current + start-next transition instead of two calls.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Id of the todo to patch.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            content: { type: 'string' },
            activeForm: { type: 'string' },
          },
          required: ['id'],
        },
      },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    ctx.signal?.throwIfAborted();
    const guard = guardTrackWriteOverApprove(ctx);
    if (guard) return err(guard);
    // Two mutually exclusive arg shapes: legacy single (top-level id) or batch.
    const hasBatch = args.updates !== undefined;
    const hasSingle =
      args.id !== undefined || args.status !== undefined || args.content !== undefined || args.activeForm !== undefined;
    if (hasBatch && hasSingle) {
      return err('update_todo: pass EITHER the single top-level {id, ...} form OR `updates: [...]` — not both.');
    }

    let patches: TodoPatch[];
    if (hasBatch) {
      if (!Array.isArray(args.updates) || args.updates.length === 0) {
        return err('update_todo: `updates` must be a non-empty array of {id, status?, content?, activeForm?}');
      }
      if (args.updates.length > MAX_PATCHES_PER_CALL) {
        return err(`update_todo: too many patches (${args.updates.length}, max ${MAX_PATCHES_PER_CALL}).`);
      }
      patches = [];
      const seen = new Set<string>();
      for (let i = 0; i < args.updates.length; i++) {
        const raw = args.updates[i];
        if (typeof raw !== 'object' || raw === null) {
          return err(`update_todo: updates[${i}] must be an object with {id, status?, content?, activeForm?}`);
        }
        const parsed = parsePatch(raw as Record<string, unknown>, `updates[${i}]`);
        if (!parsed.ok) return err(parsed.error);
        if (seen.has(parsed.patch.id)) {
          return err(`update_todo: updates[${i}] repeats id '${parsed.patch.id}' — merge the patches for one item.`);
        }
        seen.add(parsed.patch.id);
        patches.push(parsed.patch);
      }
    } else {
      if (typeof args.id !== 'string' || !args.id.trim()) return err('update_todo: id is required');
      const parsed = parsePatch(args as Record<string, unknown>, 'call');
      if (!parsed.ok) return err(parsed.error);
      patches = [parsed.patch];
    }

    const runner = (ctx.runner) as unknown as
      | { setTodos?: (t: TodoItem[]) => void | Promise<void>; currentTodos?: TodoItem[] }
      | undefined;
    if (!runner || typeof runner.setTodos !== 'function') {
      return err('update_todo requires a runner that supports todo tracking.');
    }

    const current = Array.isArray(runner.currentTodos) ? runner.currentTodos : [];
    if (current.length === 0) {
      return err('update_todo: no active todo list — call todo_write first to create one.');
    }

    // Resolve ALL ids before applying anything — a batch is atomic: one
    // unknown id rejects the call and the list is left untouched.
    const indexById = new Map(current.map((t, i) => [t.id, i]));
    for (const p of patches) {
      if (!indexById.has(p.id)) {
        const knownIds = current.map((t) => t.id).join(', ');
        return err(
          `update_todo: id '${p.id}' not found — nothing was applied. Known ids: ${knownIds}. ` +
            `Pass exact ids from the most recent todo_write result.`,
        );
      }
    }

    const next: TodoItem[] = current.map((t) => ({ ...t }));
    for (const p of patches) {
      const target = next[indexById.get(p.id)!];
      if (p.status) target.status = p.status;
      if (p.content) target.content = p.content;
      if (p.activeForm) target.activeForm = p.activeForm;
    }

    await runner.setTodos(next);

    // Invariant check runs on the FINAL state — the whole point of the batch
    // form is that the complete-current + start-next pair never produces a
    // transient 0-or-2 in_progress snapshot.
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
