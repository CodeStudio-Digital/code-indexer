/**
 * Session Drive tools — the agent's interface to its own durable working
 * memory in a single (non-company) coder session. Registered only outside
 * company context; they read/write through `ctx.sessionDrive`, wired by
 * `runCoder` to the SessionStore (migrations 125/126).
 *
 *   - read_plan             — re-read the plan you submitted (it's otherwise
 *                             write-only and lost after compaction).
 *   - save_note             — jot a note that survives compaction (this session).
 *   - list_notes            — browse the notes you saved.
 *   - recall_investigations — find a past sub-agent exploration BEFORE you
 *                             spawn a new one, to avoid re-running the query.
 *
 * NOTE vs MEMORY: these `*_note` tools are SESSION-scoped (ephemeral working
 * scratchpad). They are deliberately distinct from `mcp__save_memory` /
 * `mcp__search_memory`, which are PROJECT-wide and cross-session.
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
  mutates: false,
  parallelSafe: true,
  riskLevel: 'read',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx): Promise<ToolResult> => {
    const d = drive(ctx);
    if (!d) return err(UNAVAILABLE);
    const plan = d.readActivePlan();
    if (!plan) return ok('No plan has been submitted in this session yet. Call submit_plan when you have one.');
    return ok(`# Active plan (status: ${plan.status})\n\n${plan.text}`);
  },
};

export const saveNoteTool: CoderTool = {
  name: 'save_note',
  description:
    "Save a note to THIS session's working scratchpad — re-surfaced to you after context " +
    'compaction and shown in the Session Drive panel.\n' +
    'USE: a decision you made and why, a non-obvious fact about the codebase, a risk to watch, ' +
    'a TODO you must not forget — anything you would regret losing when older turns are summarized.\n' +
    'SCOPE: this session only (ephemeral). For a durable PROJECT fact that should outlive this ' +
    'session (a convention, gotcha, architecture note), use `mcp__save_memory` instead.\n' +
    "DON'T: dump file contents (read them again) or restate the current task. Keep it tight.\n" +
    '`title` is the key — calling save_note again with the same title updates that note. ' +
    'Review your notes with `list_notes`.',
  source: 'native',
  mutates: false,
  parallelSafe: false,
  riskLevel: 'write',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short unique key for the note (e.g. "auth flow lives in").' },
      body: { type: 'string', description: 'The note content. Concrete > vague.' },
      kind: { type: 'string', enum: ['decision', 'fact', 'risk', 'todo'], description: 'Soft tag for grouping. Default "fact".' },
      pinned: { type: 'boolean', description: 'Pin to always surface it after compaction (use sparingly).' },
    },
    required: ['title', 'body'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const d = drive(ctx);
    if (!d) return err(UNAVAILABLE);
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const body = typeof args.body === 'string' ? args.body.trim() : '';
    if (!title) return err('save_note: `title` is required and non-empty.');
    if (!body) return err('save_note: `body` is required and non-empty.');
    try {
      const saved = d.remember({
        title,
        body,
        kind: typeof args.kind === 'string' ? args.kind : undefined,
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
  // Auto-repeatable via the `list_*` prefix.
  name: 'list_notes',
  description:
    'List the notes you saved with `save_note` in this session. Optional `kind` filter ' +
    '(decision/fact/risk/todo). Pinned notes first, then most recently updated.',
  source: 'native',
  mutates: false,
  parallelSafe: true,
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
    const rows = d.listMemory({ kind: typeof args.kind === 'string' ? args.kind : undefined });
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
