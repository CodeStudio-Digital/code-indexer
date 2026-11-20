import { defineTool, type IndexTool } from '../tool.js';
import { searchMemory } from './search-memory.js';
import { parseProjectMemoryInput, PROJECT_MEMORY_CATEGORIES } from '@mcp/shared/memory-write.js';
import { MemoryExtractor } from '@mcp/services/memory/extractor.js';
import { AgentMemoryWriter, AgentMemoryDedupeSearch } from '@mcp/services/memory/agent-memory-writer.js';
import { withProject } from './_helpers.js';

// ─── Memory-framed tools (Mem D) ─────────────────────────────────────
// Bridged to Agent Memory (migration 181) — the SAME store the native
// remember / recall_memory tools use. The legacy snapshot CRUD + query tools
// (add/list/update/delete/get_snapshot_history/query_snapshots/
// get_project_context/get_context_for) were retired from the MCP surface:
// 0 calls in telemetry, superseded by agent memory, and the host UI drives
// snapshot CRUD through @mcp/api-handlers, not this server. The underlying
// SnapshotService store is untouched — it's simply no longer exposed as tools.

const save_memory = defineTool({
  name: 'save_memory',
  tier: 'navigate',
  access: 'write',
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
      category: { type: 'string', enum: [...PROJECT_MEMORY_CATEGORIES] },
      content: { type: 'string' },
      referenced_files: {
        type: 'array', items: { type: 'string' },
        description: 'Project-relative paths this memory depends on (staleness tracking).',
      },
      importance: { type: 'number', description: '0..1 salience — how reusable/durable. Decisions/conventions high.' },
    },
    required: ['project_name', 'title', 'category', 'content'],
  },
  handler: withProject(async (args, { db, agentMemoryService, signal }, project) => {
    signal?.throwIfAborted();
    const entry = parseProjectMemoryInput(args);
    const control = { signal, deferEmbeddings: agentMemoryService.hasDurableMutationQueue,
      assertCurrent: () => signal?.throwIfAborted() };
    const literal = new MemoryExtractor(
      { distill: async () => [{ ...entry, importance: entry.importance ?? 0.6 }] },
      new AgentMemoryWriter(db, agentMemoryService, undefined, control),
      new AgentMemoryDedupeSearch(agentMemoryService, signal),
    );
    const res = await literal.extractAndPersist(project.id, project.name, 'agent', {});
    try {
      db.withBusyTimeout(0, () => db.recordAgentMemoryEvent({
        eventType: 'remember', scope: 'project', projectId: project.id,
        kept: res.created + res.merged, dropped: res.skipped,
        meta: { tool: 'save_memory', created: res.created, merged: res.merged },
      }));
    } catch { /* The committed write must not fail because of diagnostics. */ }
    signal?.throwIfAborted();
    const what = res.merged > 0 ? 'merged into existing memory' : res.created > 0 ? 'saved' : 'skipped';
    return `Memory "${entry.title}" ${what} (created=${res.created} merged=${res.merged}).`;
  }),
});

export const snapshotTools: IndexTool[] = [
  searchMemory,
  save_memory,
];
