/**
 * Project-memory tools — the agent's read interface to the durable,
 * cross-session PROJECT MEMORY (snapshots table: distilled facts, gotchas,
 * conventions, procedure recipes, promoted notes).
 *
 * The write path is `save_note({scope:'project'})` (session-drive-tools);
 * this module owns retrieval: `recall_memory` fetches FULL memory content by
 * meaning, complementing the automatic top-3 relevance injection (which only
 * carries short excerpts) and the turn-1 memory index (titles only).
 *
 * Wired through `ctx.projectMemory` (host callback via RunCoderOptions) —
 * degrades to a clear message when absent (company / subagents / tests).
 */
import type { CoderTool, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';

const UNAVAILABLE =
  'Project memory is not available in this context (no project or memory disabled).';

const MAX_LIMIT = 12;
const DEFAULT_LIMIT = 5;

export const recallMemoryTool: CoderTool = {
  // Repeatable: legitimate to call with different queries while researching.
  name: 'recall_memory',
  description:
    'Search this project\'s durable PROJECT MEMORY (past decisions and their why, conventions, ' +
    'non-obvious gotchas, how-to recipes — learned across ALL previous sessions) by meaning and ' +
    'fetch the FULL content.\n' +
    'USE: when the memory index mentions a relevant title, BEFORE re-exploring something this ' +
    'project likely already learned, or when the user references a past decision.\n' +
    'Results may be stale — verify against the current code before relying on them.',
  source: 'native',
  mutates: false,
  parallelSafe: true,
  repeatable: true,
  riskLevel: 'read',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What you want to recall (e.g. "test rebuild gotcha", "why Verdaccio").',
      },
      limit: {
        type: 'number',
        description: `Max memories to return (1-${MAX_LIMIT}). Default ${DEFAULT_LIMIT}.`,
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const pm = ctx.projectMemory;
    if (!pm) return err(UNAVAILABLE);
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return err('recall_memory: `query` is required and non-empty.');
    const limitRaw = typeof args.limit === 'number' ? Math.floor(args.limit) : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIMIT, limitRaw));

    try {
      const rows = await pm.recall(query, limit);
      if (rows.length === 0) {
        return ok(
          `No project memory matches "${query}". If you learn something durable here, ` +
          'save it with save_note({scope:"project"}).',
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
      return ok(`Project memory for "${query}" (${rows.length}):\n\n${body}`);
    } catch (e) {
      return err(`recall_memory failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export function buildProjectMemoryTools(): CoderTool[] {
  return [recallMemoryTool];
}
