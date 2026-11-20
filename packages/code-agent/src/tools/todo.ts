import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { type TodoItem, generateTodoId, effectiveGate } from '@mcp/code-agent/tools/task-list-shared.js';

/**
 * Checklist handlers — the `track` (lightweight checklist) gate of the unified
 * `task_list` tool. They are internal: the former `todo_write`/`update_todo`
 * tools are no longer registered (history renderers still read those names).
 *
 *   - track (these) does NOT pause. It broadcasts "here's what I'm doing" — the
 *     dashboard renders it as a live sidebar checklist.
 *   - approve (`task_list({gate:'approve'})`) PAUSES for user
 *     approval and is the only thing that arms `execute_tasks`.
 *
 * Both gates write the same session-local task record,
 * so a checklist and an approve list can never coexist as parallel lists.
 *
 * Each TodoItem carries a stable `id` (8-char hex). The id lets a
 * `task_list({updates})` patch a single item without re-sending the full list.
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
    // otherwise mint a fresh one. Keeps checklist patch cycles stable across
    // full-list re-submissions when the agent passes ids back through.
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

// ─── Burst guard for checklist rewrites ────────────────────────────────────────
//
// Avoid repeated checklist writes. When the agent reissues
// a full checklist write with the same logical list 3+ times inside 90s without any
// real change in between, we hard-refuse and point them at task_list({updates}).
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

// ─── checklist write (task_list track) ────────────────────────────────────────────────────────

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

/**
 * Internal handler of `task_list({gate:'track', items})`. Not registered as a
 * tool: `task_list` is the only task/checklist tool the model sees.
 */
export const todoWrite: Pick<CoderTool, 'handler'> = {
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
      return err('task_list requires a runner that supports checklist tracking.');
    }

    // Burst guard: refuse repeated rewrites of the same logical list.
    // Empty-list (clear) and signature changes both reset the counter — only
    // identical re-submissions count.
    if (todos.length > 0) {
      const burst = bumpWriteBurst(ctx, todos);
      if (burst.count > WRITE_BURST_THRESHOLD) {
        const ids = todos.map((t) => t.id).join(', ');
        return err(
          `Refused: task_list called ${burst.count} times in the last ${Math.round(WRITE_BURST_WINDOW_MS / 1000)}s ` +
            `with the same checklist and no intervening progress. ` +
            `Patch items with task_list({updates: [{id, status}, …]}) instead of re-sending the whole list. ` +
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

// ─── checklist patch (task_list updates) ───────────────────────────────────────────────────────

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
  if (!id) return { ok: false, error: `task_list: ${label}.id is required` };

  const status = raw.status;
  const content = typeof raw.content === 'string' ? raw.content.trim() : undefined;
  const activeForm = typeof raw.activeForm === 'string' ? raw.activeForm.trim() : undefined;
  if (content && content.length > 8192 || activeForm && activeForm.length > 8192) {
    return { ok: false, error: `task_list: ${label} text exceeds 8192 characters` };
  }
  const hasStatus = status === 'pending' || status === 'in_progress' || status === 'completed';
  // Validate status first — reject an explicitly bad value before falling
  // through to the "no fields provided" check, otherwise the caller gets a
  // misleading "at least one of …" error when they really passed a bad status.
  if (status !== undefined && !hasStatus) {
    return { ok: false, error: `task_list: ${label}.status must be pending|in_progress|completed, got '${String(status)}'` };
  }
  if (!hasStatus && !content && !activeForm) {
    return { ok: false, error: `task_list: ${label} needs at least one of {status, content, activeForm}` };
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

/** Internal handler of `task_list({updates})`. Not registered as a tool. */
export const updateTodo: Pick<CoderTool, 'handler'> = {
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    ctx.signal?.throwIfAborted();
    const guard = guardTrackWriteOverApprove(ctx);
    if (guard) return err(guard);
    // Two mutually exclusive arg shapes: legacy single (top-level id) or batch.
    const hasBatch = args.updates !== undefined;
    const hasSingle =
      args.id !== undefined || args.status !== undefined || args.content !== undefined || args.activeForm !== undefined;
    if (hasBatch && hasSingle) {
      return err('task_list: pass EITHER the single top-level {id, ...} form OR `updates: [...]` — not both.');
    }

    let patches: TodoPatch[];
    if (hasBatch) {
      if (!Array.isArray(args.updates) || args.updates.length === 0) {
        return err('task_list: `updates` must be a non-empty array of {id, status?, content?, activeForm?}');
      }
      if (args.updates.length > MAX_PATCHES_PER_CALL) {
        return err(`task_list: too many patches (${args.updates.length}, max ${MAX_PATCHES_PER_CALL}).`);
      }
      patches = [];
      const seen = new Set<string>();
      for (let i = 0; i < args.updates.length; i++) {
        const raw = args.updates[i];
        if (typeof raw !== 'object' || raw === null) {
          return err(`task_list: updates[${i}] must be an object with {id, status?, content?, activeForm?}`);
        }
        const parsed = parsePatch(raw as Record<string, unknown>, `updates[${i}]`);
        if (!parsed.ok) return err(parsed.error);
        if (seen.has(parsed.patch.id)) {
          return err(`task_list: updates[${i}] repeats id '${parsed.patch.id}' — merge the patches for one item.`);
        }
        seen.add(parsed.patch.id);
        patches.push(parsed.patch);
      }
    } else {
      if (typeof args.id !== 'string' || !args.id.trim()) return err('task_list: id is required');
      const parsed = parsePatch(args as Record<string, unknown>, 'call');
      if (!parsed.ok) return err(parsed.error);
      patches = [parsed.patch];
    }

    const runner = (ctx.runner) as unknown as
      | { setTodos?: (t: TodoItem[]) => void | Promise<void>; currentTodos?: TodoItem[] }
      | undefined;
    if (!runner || typeof runner.setTodos !== 'function') {
      return err('task_list requires a runner that supports checklist tracking.');
    }

    const current = Array.isArray(runner.currentTodos) ? runner.currentTodos : [];
    if (current.length === 0) {
      return err("task_list: no active checklist — create one with task_list({gate:'track', items: [...]}) first.");
    }

    // Resolve ALL ids before applying anything — a batch is atomic: one
    // unknown id rejects the call and the list is left untouched.
    const indexById = new Map(current.map((t, i) => [t.id, i]));
    for (const p of patches) {
      if (!indexById.has(p.id)) {
        const knownIds = current.map((t) => t.id).join(', ');
        return err(
          `task_list: id '${p.id}' not found — nothing was applied. Known ids: ${knownIds}. ` +
            `Pass exact ids from the most recent task_list result.`,
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

