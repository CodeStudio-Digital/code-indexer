/**
 * Session Drive tools — the agent's interface to its own durable working
 * memory in a single (non-company) coder session. Registered only outside
 * company context; they read/write through `ctx.sessionDrive`, wired by
 * `runCoder` to the SessionStore (migrations 125/126).
 *
 *   - read_plan             — re-read the plan you submitted (it's otherwise
 *                             write-only and lost after compaction).
 *   - save_note             — jot a note that survives compaction. scope
 *                             'session' (default) = this session's scratchpad;
 *                             scope 'project' = durable cross-session PROJECT
 *                             MEMORY via `ctx.projectMemory` (dedup'd like the
 *                             distillers).
 *   - list_notes            — browse the session notes you saved.
 *   - recall_investigations — find a past sub-agent exploration BEFORE you
 *                             spawn a new one, to avoid re-running the query.
 *
 * The MCP twins `mcp__save_memory` / `mcp__search_memory` remain the
 * bridge-only alternative path (company / external MCP clients).
 *
 * All degrade to a clear message when `ctx.sessionDrive` is absent (company
 * sessions / subagents / tests) instead of throwing.
 */
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err, unknownToolOutcome } from '@mcp/code-agent/core/tool.js';
import { assertMutationFence } from '../core/mutation-fence.js';
import { assertSessionDataCurrent } from './session-data-context.js';

const UNAVAILABLE = 'Session Drive is only available in a normal project session (not company/subagent).';

function drive(ctx: ToolContext) {
  return ctx.sessionDrive ?? null;
}

export const readPlanTool: CoderTool = {
  name: 'read_plan',
  description:
    'Re-read the plan you submitted earlier (via submit_plan) plus its approval status. ' +
    'USE: after a compaction, when resuming, or any time you are unsure whether you are still ' +
    'following the agreed plan — the plan is otherwise not visible once it scrolls out of context. ' +
    'For task-level progress use list_tasks instead.',
  source: 'native',
  outputPolicy: { mode: 'authoritative', reducer: 'none', recovery: 'output_store', preserveOnError: true },
  mutates: false,
  parallelSafe: true,
  riskLevel: 'read',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx): Promise<ToolResult> => {
    assertSessionDataCurrent(ctx);
    const d = drive(ctx);
    if (!d) return err(UNAVAILABLE);
    const plan = await d.readActivePlan(ctx.signal);
    assertSessionDataCurrent(ctx);
    if (!plan) return ok('No plan has been submitted in this session yet. Call submit_plan when you have one.');
    return ok(`# Active plan (status: ${plan.status})\n\n${plan.text}`);
  },
};

/** save_note kind → durable memory category for scope 'project'. */
const KIND_TO_CATEGORY: Record<string, string> = {
  decision: 'decision',
  gotcha: 'gotcha',
  convention: 'convention',
  procedure: 'procedure',
  risk: 'gotcha',
  fact: 'note',
  todo: 'todo',
};

/** For scope 'user': "who the user is" (fact) → user; everything else (a
 *  working preference / correction) → feedback. */
function userCategoryForKind(kind: string): string {
  return kind === 'fact' ? 'user' : 'feedback';
}

export const saveNoteTool: CoderTool = {
  name: 'save_note',
  description:
    'Save a SESSION note — a working-scratchpad fact/decision/risk/TODO for THIS session, ' +
    're-surfaced to you after context compaction and shown in the Session Drive panel. ' +
    '`title` is the key (re-saving updates it); review with `list_notes`.\n' +
    'This is NOT durable memory. For a fact FUTURE sessions should recall (a decision and its why, a ' +
    'convention, a gotcha, a recipe) use `remember`; for a global fact about the user, ' +
    '`remember({scope:"user"})`.',
  source: 'native',
  mutates: true,
  effectBoundary: 'control',
  parallelSafe: false,
  riskLevel: 'write',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short unique key for the note (e.g. "auth flow lives in").' },
      body: { type: 'string', description: 'The note content. Concrete > vague.' },
      kind: {
        type: 'string',
        enum: ['decision', 'fact', 'risk', 'todo', 'gotcha', 'convention', 'procedure'],
        description: 'Soft tag. For scope "project" it maps to the memory category. Default "fact".',
      },
      pinned: { type: 'boolean', description: 'Pin to always surface it after compaction (use sparingly).' },
    },
    required: ['title', 'body'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    assertSessionDataCurrent(ctx);
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const body = typeof args.body === 'string' ? args.body.trim() : '';
    if (!title) return err('save_note: `title` is required and non-empty.');
    if (!body) return err('save_note: `body` is required and non-empty.');
    if (title.length > 512 || body.length > 64_000) return err('save_note: title exceeds 512 or body exceeds 64000 characters.');
    const kind = typeof args.kind === 'string' ? args.kind : 'fact';
    if (!Object.hasOwn(KIND_TO_CATEGORY, kind)) return err('save_note: invalid kind.');
    if (args.pinned !== undefined && typeof args.pinned !== 'boolean') return err('save_note: pinned must be boolean.');
    if (args.scope !== undefined && !['session', 'project', 'user'].includes(args.scope as string)) return err('save_note: invalid scope.');
    if (args.scope && args.scope !== 'session' && ctx.sessionDrive?.assertCurrent) {
      return err('save_note writes session notes for this session. Use remember for project/user memory.');
    }

    if (args.scope === 'project') {
      const pm = ctx.projectMemory;
      if (!pm) {
        return err(
          'project memory is not available in this context — nothing was saved. ' +
          'Retry with scope "session" to keep it in the session scratchpad.',
        );
      }
      assertMutationFence(ctx.mutationFence, { kind: 'control', operation: 'save_note', resource: 'save_note' });
      try {
        const res = await pm.save({ title, content: body, category: KIND_TO_CATEGORY[kind] ?? 'note' });
        assertSessionDataCurrent(ctx);
        if (!res) return err('save_note (project): memory persistence is unavailable.');
        if (!res.created && !res.merged) return ok(`No new project memory was written for "${title}" (${res.skipped} skipped).`);
        const what = res.merged > 0 ? 'merged into existing memory' : 'saved';
        return ok(`Project memory "${title}" ${what}. Future sessions on this codebase will retrieve it.`);
      } catch (e) {
        return unknownToolOutcome(`save_note (project) did not confirm its write: ${e instanceof Error ? e.message : String(e)}. Reconcile memory before retrying.`);
      }
    }

    if (args.scope === 'user') {
      const um = ctx.userMemory;
      if (!um) {
        return err(
          'user memory is not available in this context — nothing was saved. ' +
          'Retry with scope "session" to keep it in the session scratchpad.',
        );
      }
      assertMutationFence(ctx.mutationFence, { kind: 'control', operation: 'save_note', resource: 'save_note' });
      try {
        const res = await um.save({ title, content: body, category: userCategoryForKind(kind) });
        assertSessionDataCurrent(ctx);
        if (!res) return err('save_note (user): memory persistence is unavailable.');
        if (!res.created && !res.merged) return ok(`No new user memory was written for "${title}" (${res.skipped} skipped).`);
        const what = res.merged > 0 ? 'merged into existing memory' : 'saved';
        return ok(`User memory "${title}" ${what}. It will inform you in every project going forward.`);
      } catch (e) {
        return unknownToolOutcome(`save_note (user) did not confirm its write: ${e instanceof Error ? e.message : String(e)}. Reconcile memory before retrying.`);
      }
    }

    const d = drive(ctx);
    if (!d) return err(UNAVAILABLE);
    const beforePublish = () => {
      assertSessionDataCurrent(ctx);
      assertMutationFence(ctx.mutationFence, { kind: 'control', operation: 'save_note', resource: 'save_note' });
    };
    beforePublish();
    try {
      const saved = await d.remember({
        title,
        body,
        kind,
        pinned: args.pinned === true,
        ...(ctx.currentToolUseId ? { operation_id: `save_note:${ctx.currentToolUseId}` } : {}),
      }, beforePublish);
      assertSessionDataCurrent(ctx);
      // Live-update the Drive panel (SSE → DOM bridge → refetch).
      ctx.runner?.emit('session_drive_changed', { kind: 'memory' });
      return ok(`Saved note "${saved.title}".`);
    } catch (e) {
      return unknownToolOutcome(`save_note did not confirm its commit: ${e instanceof Error ? e.message : String(e)}. Read list_notes to reconcile; do not repeat automatically.`);
    }
  },
};

export const listNotesTool: CoderTool = {
  name: 'list_notes',
  description:
    'List the notes you saved with `save_note` in this session. Optional `kind` filter ' +
    '(decision/fact/risk/todo/gotcha/convention/procedure). Pinned notes first, then most recently updated. ' +
    'Pages use a live offset; restart from zero if notes change between calls.',
  source: 'native',
  mutates: false,
  parallelSafe: true,
  repeatPolicy: 'volatile',
  riskLevel: 'read',
  outputPolicy: { mode: 'authoritative', reducer: 'none', recovery: 'output_store', preserveOnError: true },
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: Object.keys(KIND_TO_CATEGORY), description: 'Only return notes of this kind.' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Notes per page (default 20).' },
      offset: { type: 'integer', minimum: 0, maximum: 10000, description: 'Next offset returned by the prior call.' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    assertSessionDataCurrent(ctx);
    const d = drive(ctx);
    if (!d) return err(UNAVAILABLE);
    const limit = args.limit ?? 20, offset = args.offset ?? 0;
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 50
      || !Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > 10_000) return err('list_notes: invalid limit or offset.');
    if (args.kind !== undefined && (typeof args.kind !== 'string' || !Object.hasOwn(KIND_TO_CATEGORY, args.kind))) return err('list_notes: invalid kind.');
    const rows = await d.listMemory({
      kind: typeof args.kind === 'string' ? args.kind : undefined,
      limit: (limit as number) + 1, offset: offset as number, signal: ctx.signal,
    });
    assertSessionDataCurrent(ctx);
    if (rows.length === 0) return ok(offset || args.kind ? 'No notes in this page or filter. Restart at offset=0 or change kind.' : 'No notes saved yet. Use `save_note` to save one.');
    const body = rows.slice(0, limit as number)
      .map((m) => `- ${m.pinned ? '📌 ' : ''}[${m.kind}] ${m.title}: ${m.body.replace(/\s*\n\s*/g, ' ')}`)
      .join('\n');
    const more = rows.length > (limit as number);
    return ok(`Session notes (${Math.min(rows.length, limit as number)} in this page):\n${body}\n\n${more
      ? (Number(offset) + Number(limit) <= 10_000 ? `More notes are available. Continue with offset=${Number(offset) + Number(limit)} and the same kind/limit.`
        : 'The maximum browsing offset was reached. Narrow the kind filter to inspect more notes.') : 'End of notes.'}`);
  },
};

export const recallInvestigationsTool: CoderTool = {
  // Repeatable: not a list_/wait_ prefix, so flag it explicitly.
  name: 'recall_investigations',
  description:
    'Search past sub-agent explorations (auto-saved when a spawn_agent finishes) for this project ' +
    'BEFORE you spawn a new one — reuse a prior finding instead of paying to re-investigate. ' +
    'Keyword-matches the topic/summary. Returns the digests; read the matching one rather than re-running it.',
  source: 'native',
  mutates: false,
  parallelSafe: true,
  repeatable: true,
  riskLevel: 'read',
  outputPolicy: { mode: 'authoritative', reducer: 'none', recovery: 'output_store', preserveOnError: true },
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What you are about to investigate (e.g. "auth flow", "stripe webhook").' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    assertSessionDataCurrent(ctx);
    const d = drive(ctx);
    if (!d) return err(UNAVAILABLE);
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query || query.length > 2000) return err('recall_investigations: query must contain 1-2000 characters.');
    const rows = await d.recallInvestigations(query, 8, ctx.signal);
    assertSessionDataCurrent(ctx);
    if (rows.length === 0) return ok(`No prior investigation matches "${query}". Safe to spawn a fresh one.`);
    const body = rows
      .map((r, i) => `### ${i + 1}. ${r.topic}\n[${r.agent_type ?? 'explore'} · ${r.created_at}]\n${r.summary}`)
      .join('\n\n');
    return ok(`Found ${rows.length} prior investigation(s) for "${query}":\n\n${body}`);
  },
};

export function buildSessionDriveTools(): CoderTool[] {
  return [readPlanTool, saveNoteTool, listNotesTool, recallInvestigationsTool];
}
