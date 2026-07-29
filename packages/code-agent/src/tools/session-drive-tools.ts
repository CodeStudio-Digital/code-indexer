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
import { ok, err } from '@mcp/code-agent/core/tool.js';

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
    const d = drive(ctx);
    if (!d) return err(UNAVAILABLE);
    const plan = await d.readActivePlan();
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
  mutates: false,
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
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const body = typeof args.body === 'string' ? args.body.trim() : '';
    if (!title) return err('save_note: `title` is required and non-empty.');
    if (!body) return err('save_note: `body` is required and non-empty.');
    const kind = typeof args.kind === 'string' ? args.kind : 'fact';

    if (args.scope === 'project') {
      const pm = ctx.projectMemory;
      if (!pm) {
        return err(
          'project memory is not available in this context — nothing was saved. ' +
          'Retry with scope "session" to keep it in the session scratchpad.',
        );
      }
      try {
        const res = await pm.save({ title, content: body, category: KIND_TO_CATEGORY[kind] ?? 'note' });
        const what = res && res.merged > 0 ? 'merged into existing memory' : 'saved';
        return ok(`Project memory "${title}" ${what}. Future sessions on this codebase will retrieve it.`);
      } catch (e) {
        return err(`save_note (project) failed: ${e instanceof Error ? e.message : String(e)}`);
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
      try {
        const res = await um.save({ title, content: body, category: userCategoryForKind(kind) });
        const what = res && res.merged > 0 ? 'merged into existing memory' : 'saved';
        return ok(`User memory "${title}" ${what}. It will inform you in every project going forward.`);
      } catch (e) {
        return err(`save_note (user) failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const d = drive(ctx);
    if (!d) return err(UNAVAILABLE);
    try {
      const saved = await d.remember({
        title,
        body,
        kind,
        pinned: args.pinned === true,
      });
      // Live-update the Drive panel (SSE → DOM bridge → refetch).
      ctx.runner?.emit('session_drive_changed', { kind: 'memory' });
      return ok(`Saved note "${saved.title}".`);
    } catch (e) {
      return err(`save_note failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export const listNotesTool: CoderTool = {
  name: 'list_notes',
  description:
    'List the notes you saved with `save_note` in this session. Optional `kind` filter ' +
    '(decision/fact/risk/todo). Pinned notes first, then most recently updated.',
  source: 'native',
  mutates: false,
  parallelSafe: true,
  repeatPolicy: 'volatile',
  riskLevel: 'read',
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['decision', 'fact', 'risk', 'todo'], description: 'Only return notes of this kind.' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const d = drive(ctx);
    if (!d) return err(UNAVAILABLE);
    const rows = await d.listMemory({
      kind: typeof args.kind === 'string' ? args.kind : undefined,
    });
    if (rows.length === 0) return ok('No notes saved yet. Use `save_note` to save one.');
    const body = rows
      .map((m) => `- ${m.pinned ? '📌 ' : ''}[${m.kind}] ${m.title}: ${m.body.replace(/\s*\n\s*/g, ' ')}`)
      .join('\n');
    return ok(`Session notes (${rows.length}):\n${body}`);
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
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What you are about to investigate (e.g. "auth flow", "stripe webhook").' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const d = drive(ctx);
    if (!d) return err(UNAVAILABLE);
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return err('recall_investigations: `query` is required and non-empty.');
    const rows = await d.recallInvestigations(query, 8);
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
