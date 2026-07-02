import { defineTool, type McpTool } from '../tool.js';
import type { SnapshotCategory } from '@mcp/shared/types.js';
import { MemoryExtractor } from '@mcp/services/memory/extractor.js';
import { AgentMemoryWriter, AgentMemoryDedupeSearch } from '@mcp/services/memory/agent-memory-writer.js';
import { withProject, type ProjectToolHandler } from './_helpers.js';

/**
 * Wrap a memory tool handler so any thrown error becomes a structured
 * response instead of a raw stack trace at the MCP layer. JSON callers get
 * `{ error: "..." }`, text callers get `Memory operation failed: ...`.
 *
 * Stays inside this file on purpose — the surrounding tool catalogue does
 * its own error mapping, so a generic wrapper would overreach.
 */
function withMemoryErrorHandling(
  handler: ProjectToolHandler,
): ProjectToolHandler {
  return async (args, ctx, project, authCtx) => {
    try {
      return await handler(args, ctx, project, authCtx);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      if (args.format === 'json') {
        return JSON.stringify({ error: message });
      }
      return `Memory operation failed: ${message}`;
    }
  };
}

// ─── Memory-framed tools (Mem D) ─────────────────────────────────────
// Bridged to Agent Memory (migration 181) — the SAME store the native
// remember / recall_memory tools use. The legacy snapshot CRUD + query tools
// (add/list/update/delete/get_snapshot_history/query_snapshots/
// get_project_context/get_context_for) were retired from the MCP surface:
// 0 calls in telemetry, superseded by agent memory, and the host UI drives
// snapshot CRUD through @mcp/api-handlers, not this server. The underlying
// SnapshotService store is untouched — it's simply no longer exposed as tools.

const search_memory = defineTool({
  name: 'search_memory',
  description:
    'Search PROJECT MEMORY (past decisions, conventions, gotchas, how-to recipes, architecture, and auto-indexed facts) by meaning — hybrid FTS+vector. USE before exploring code or figuring out how to run/build/test/deploy; many answers are already remembered. DON\'T use for live file contents (use read_file). Pass format="json" for structured results.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      query: { type: 'string' },
      limit: { type: 'number' },
      format: { type: 'string', enum: ['text', 'json'] },
    },
    required: ['project_name', 'query'],
  },
  handler: withProject(withMemoryErrorHandling(async (args, { db, agentMemoryService }, project) => {
    const query = (args.query as string).trim();
    if (!query) return 'search_memory requires a non-empty query.';
    const limit = (args.limit as number) ?? 5;
    // Bridged to Agent Memory (migration 181) — the SAME store the native
    // recall_memory reads, so company/external-MCP writes are recalled (no split-brain).
    const results = await agentMemoryService.search('project', project.id, query, limit);
    if (results.length === 0) {
      const total = db.countAgentMemory('project', project.id);
      return total === 0
        ? 'No project memory yet. Use save_memory (or remember) to record one.'
        : `No memory matched "${query}" (${total} entries exist). Try broader terms.`;
    }
    if (args.format === 'json') {
      return JSON.stringify({
        query,
        total: results.length,
        results: results.map((s) => ({
          id: s.id, title: s.name, category: s.type, content: s.content,
          source: s.source, importance: s.importance,
        })),
      });
    }
    return results.map((s) => `## ${s.name} [${s.type}]\n${s.content}`).join('\n\n---\n\n');
  })),
});

const save_memory = defineTool({
  name: 'save_memory',
  description:
    'Save a DURABLE fact to PROJECT MEMORY so future sessions can recall it.\n' +
    'Good memories: a decision (and why), a convention, a non-obvious gotcha/constraint, a reusable how-to recipe, an architecture note. Provide a specific title + 1-4 sentence content.\n' +
    "USE: for things that stay true beyond the current task.\n" +
    "DON'T: use for transient task state — that belongs in the task list, not memory.",
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      title: { type: 'string' },
      category: { type: 'string', enum: ['architecture', 'decision', 'pattern', 'convention', 'todo', 'note', 'gotcha', 'procedure'] },
      content: { type: 'string' },
      referenced_files: {
        type: 'array', items: { type: 'string' },
        description: 'Project-relative paths this memory depends on (staleness tracking).',
      },
      importance: { type: 'number', description: '0..1 salience — how reusable/durable. Decisions/conventions high.' },
    },
    required: ['project_name', 'title', 'category', 'content'],
  },
  handler: withProject(withMemoryErrorHandling(async (args, { db, agentMemoryService }, project) => {
    // Bridged to Agent Memory — dedup/merge + embed via the SAME path as the
    // native remember tool (deps.projectMemory.save). No more snapshot writes.
    const literal = new MemoryExtractor(
      { distill: async () => [{
        title: args.title as string,
        category: args.category as SnapshotCategory,
        content: args.content as string,
        importance: typeof args.importance === 'number' ? args.importance : 0.6,
        referencedFiles: args.referenced_files as string[] | undefined,
      }] },
      new AgentMemoryWriter(db, agentMemoryService),
      new AgentMemoryDedupeSearch(agentMemoryService),
    );
    const res = await literal.extractAndPersist(project.id, project.name, 'agent', {});
    const what = res.merged > 0 ? 'merged into existing memory' : 'saved';
    return `Memory "${args.title as string}" ${what} (created=${res.created} merged=${res.merged}).`;
  })),
});

export const snapshotTools: McpTool[] = [
  search_memory,
  save_memory,
];
