/**
 * Agent Memory tools — the agent's interface to durable, cross-session memory
 * (the dedicated `agent_memory` store, SEPARATE from snapshots and from the
 * session scratchpad `save_note`):
 *
 *   - remember        — SAVE a durable fact (project or user scope).
 *   - recall_memory   — READ memory by meaning (mode:'search', full content) or
 *                       browse the index (mode:'list', frontmatter only).
 *   - forget_memory   — ARCHIVE a memory that became wrong/obsolete.
 *
 * Wired through `ctx.projectMemory` / `ctx.userMemory` (host callbacks via
 * RunCoderOptions) — degrade to a clear message when absent (memory disabled).
 */
import type { CoderTool, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';

const UNAVAILABLE =
  'Agent memory is not available in this context (no project or memory disabled).';

const MAX_LIMIT = 12;
const DEFAULT_LIMIT = 5;

/** Closed agent-memory taxonomy (mirrors AgentMemoryType). */
const MEMORY_TYPES = [
  'preference', 'convention', 'procedure', 'architecture',
  'gotcha', 'external_pointer', 'pattern', 'decision', 'note',
] as const;

/** Closed type → a project-memory category the host writer understands
 *  (the overlapping kinds round-trip; external_pointer → note). `preference`
 *  maps to `feedback` — floor 0.75, round-trips back to type `preference` —
 *  NOT to `note` (floor 0.3), which buried the highest-value memory kind. */
const TYPE_TO_PROJECT_CATEGORY: Record<string, string> = {
  decision: 'decision',
  convention: 'convention',
  procedure: 'procedure',
  architecture: 'architecture',
  gotcha: 'gotcha',
  pattern: 'pattern',
  note: 'note',
  preference: 'feedback',
  external_pointer: 'note',
};

export const rememberTool: CoderTool = {
  name: 'remember',
  description:
    'Save a DURABLE memory that future sessions on this project (or every project, for user scope) will recall. ' +
    'Use it THE MOMENT you learn something a future agent would otherwise rediscover the hard way — a decision and ' +
    'its why, a confirmed convention, a non-obvious gotcha, a reusable recipe. Not at the end; right then. ' +
    'A user correction or stated preference is the single most valuable thing to remember.\n' +
    'scope "project" (default): a fact about THIS codebase. scope "user": a GLOBAL fact about the user or how they ' +
    'want you to work (applies to EVERY project).\n' +
    "DON'T save transient task state, progress notes, or file dumps. Re-saving a close duplicate is deduplicated.",
  source: 'native',
  mutates: false,
  parallelSafe: false,
  riskLevel: 'write',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short, specific title (e.g. "test rebuild gotcha", "auth lives in gateway").' },
      content: { type: 'string', description: 'The single durable fact. Concrete > vague.' },
      type: {
        type: 'string',
        enum: [...MEMORY_TYPES],
        description: 'What kind of fact this is. Default "note".',
      },
      scope: {
        type: 'string',
        enum: ['project', 'user'],
        description: '"project" (default) = this codebase; "user" = global fact about the user / how they want you to work.',
      },
    },
    required: ['title', 'content'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const content = typeof args.content === 'string' ? args.content.trim() : '';
    if (!title) return err('remember: `title` is required and non-empty.');
    if (!content) return err('remember: `content` is required and non-empty.');
    const type = typeof args.type === 'string' && (MEMORY_TYPES as readonly string[]).includes(args.type)
      ? args.type
      : 'note';
    const scope = args.scope === 'user' ? 'user' : 'project';

    try {
      if (scope === 'user') {
        const um = ctx.userMemory;
        if (!um) return err(`${UNAVAILABLE} (user scope)`);
        // User memory is preferences/feedback; the host maps 'feedback' → type 'preference'.
        const res = await um.save({ title, content, category: 'feedback' });
        const what = res && res.merged > 0 ? 'merged into existing user memory' : 'saved as user memory';
        return ok(`Remembered "${title}" — ${what}. It will inform you in EVERY project going forward.`);
      }
      const pm = ctx.projectMemory;
      if (!pm) return err(UNAVAILABLE);
      const res = await pm.save({ title, content, category: TYPE_TO_PROJECT_CATEGORY[type] ?? 'note' });
      const what = res && res.merged > 0 ? 'merged into existing memory' : 'saved';
      return ok(`Remembered "${title}" — project memory ${what}. Future sessions on this codebase will recall it.`);
    } catch (e) {
      return err(`remember failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export const recallMemoryTool: CoderTool = {
  // Repeatable: legitimate to call with different queries while researching.
  name: 'recall_memory',
  description:
    "Read this project's durable AGENT MEMORY (past decisions and their why, conventions, non-obvious gotchas, " +
    'how-to recipes — learned across ALL previous sessions).\n' +
    "mode 'search' (default): semantic search, returns FULL content. USE before re-exploring something this " +
    'project likely already learned, or when the user references a past decision.\n' +
    "mode 'list': browse the memory index (titles + one-liners only) — useful to see what's stored or pick a title " +
    'to search. The turn-1 index already shows top entries; use list to go wider or filter by type.\n' +
    'Results may be stale — verify against the current code before relying on them.',
  source: 'native',
  mutates: false,
  parallelSafe: true,
  repeatable: true,
  riskLevel: 'read',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['search', 'list'], description: "Default 'search'." },
      query: { type: 'string', description: "What to recall (required for mode 'search')." },
      type: { type: 'string', enum: [...MEMORY_TYPES], description: "Optional type filter (mode 'list')." },
      limit: { type: 'number', description: `Max memories (1-${MAX_LIMIT}). Default ${DEFAULT_LIMIT}.` },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const pm = ctx.projectMemory;
    if (!pm) return err(UNAVAILABLE);
    const limitRaw = typeof args.limit === 'number' ? Math.floor(args.limit) : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIMIT, limitRaw));
    const mode = args.mode === 'list' ? 'list' : 'search';

    if (mode === 'list') {
      if (!pm.list) return err('recall_memory(mode:list) is not available in this context.');
      try {
        const type = typeof args.type === 'string' ? args.type : undefined;
        const rows = await pm.list(limit, type);
        if (rows.length === 0) {
          return ok('Agent memory is empty for this project. Save durable facts with `remember` as you learn them.');
        }
        const body = rows
          .map((m) => `- [${m.type}] ${m.name}${m.description ? ` — ${m.description}` : ''}`)
          .join('\n');
        return ok(`Agent memory index (${rows.length}):\n${body}\n\nFetch full content with recall_memory({query:"<title>"}).`);
      } catch (e) {
        return err(`recall_memory(list) failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return err('recall_memory: `query` is required for mode "search".');
    try {
      const rows = await pm.recall(query, limit);
      if (rows.length === 0) {
        return ok(
          `No agent memory matches "${query}". Browse what IS stored with recall_memory({mode:'list'}) — ` +
          'a different title may cover it. If you learn something durable here, save it with `remember`.',
        );
      }
      const body = rows
        .map((m) => {
          const meta = [
            m.category ?? 'note',
            m.source ? `source: ${m.source}` : null,
            m.importance != null ? `importance: ${m.importance.toFixed(2)}` : null,
          ].filter(Boolean).join(' · ');
          const stale = m.staleNote ? `\n⚠ ${m.staleNote}` : '';
          return `## ${m.title}\n[${meta}]${stale}\n${m.content}`;
        })
        .join('\n\n');
      return ok(`Agent memory for "${query}" (${rows.length}):\n\n${body}`);
    } catch (e) {
      return err(`recall_memory failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export const forgetMemoryTool: CoderTool = {
  name: 'forget_memory',
  description:
    'Archive a durable memory you (or a past session) saved, by its title/name — use when a memory has become ' +
    'WRONG or OBSOLETE. It is a logical (reversible) archive, not a hard delete. ' +
    'scope "project" (default) or "user". If unsure of the exact title, recall_memory(mode:"list") first.',
  source: 'native',
  mutates: false,
  parallelSafe: false,
  riskLevel: 'write',
  parameters: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'The title/name of the memory to forget.' },
      scope: { type: 'string', enum: ['project', 'user'], description: 'Default "project".' },
    },
    required: ['target'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const target = typeof args.target === 'string' ? args.target.trim() : '';
    if (!target) return err('forget_memory: `target` is required and non-empty.');
    const scope = args.scope === 'user' ? 'user' : 'project';
    const forget = scope === 'user' ? ctx.userMemory?.forget : ctx.projectMemory?.forget;
    if (!forget) return err(`forget_memory (${scope}) is not available in this context.`);
    try {
      const res = await forget(target);
      return res.archived > 0
        ? ok(`Forgot "${target}" — archived from ${scope} memory.`)
        : ok(`No ${scope} memory named "${target}" found to forget. Try recall_memory(mode:"list").`);
    } catch (e) {
      return err(`forget_memory failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export function buildProjectMemoryTools(): CoderTool[] {
  return [rememberTool, recallMemoryTool, forgetMemoryTool];
}
