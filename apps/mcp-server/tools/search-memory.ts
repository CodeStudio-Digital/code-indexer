import { defineTool, mcpAccess, type McpSourceTruncation } from '../tool.js';
import { withProject } from './_helpers.js';
import { recordMemoryAccess } from '@mcp/services/memory/access-telemetry.js';

function integer(value: unknown, fallback: number, min: number, max: number) {
  const n = value ?? fallback;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min || n > max) throw new Error('Invalid memory page');
  return n;
}
export const searchMemory = defineTool({
  name: 'search_memory', tier: 'navigate', ...mcpAccess('read'),
  description: 'Search durable project memories such as decisions, conventions and gotchas through the semantic owner, with local FTS fallback. Default five results (max 50), each with 4000 content characters (max 16384). Follow a result recovery using memory_id/content_offset to read the complete current memory without repeating semantic retrieval. All IDs are checked against the live project store. Search results are ranked candidates, not an exhaustive count. Use read_file for current source code.',
  inputSchema: { type: 'object', properties: {
    project_name: { type: 'string' }, query: { type: 'string', maxLength: 4096 }, limit: { type: 'integer', minimum: 1, maximum: 50 },
    memory_id: { type: 'integer', minimum: 1 }, content_offset: { type: 'integer', minimum: 0 },
    content_limit: { type: 'integer', minimum: 1, maximum: 16384 }, format: { type: 'string', enum: ['text', 'json'] },
  }, required: ['project_name'] },
  handler: withProject(async (args, { db, agentMemoryService, semanticSearchClient, signal }, project) => {
    signal?.throwIfAborted();
    if (project.is_synthetic) throw new Error('Synthetic projects are unsupported after the filesystem-session cutover');
    const limit = integer(args.limit, 5, 1, 50), offset = integer(args.content_offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const contentLimit = integer(args.content_limit, 4000, 1, 16384);
    let ids: number[], query: string | undefined, source = 'current_store', degradedReason: string | undefined;
    if (args.memory_id != null) ids = [integer(args.memory_id, 0, 1, Number.MAX_SAFE_INTEGER)];
    else {
      if (offset) throw new Error('content_offset requires memory_id; follow a result recovery');
      query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query || query.length > 4096) throw new Error('search_memory query must contain 1..4096 characters');
      const remote = await semanticSearchClient.searchProjectMemory(project.id, query, limit, signal);
      signal?.throwIfAborted();
      const owned = remote.ok && remote.value != null;
      const hits = owned ? remote.value!.results : await agentMemoryService.search('project', project.id, query, limit, undefined, signal);
      signal?.throwIfAborted();
      source = owned ? 'semantic_owner' : 'local_fts'; degradedReason = owned ? undefined : remote.error ?? 'semantic owner unavailable';
      ids = [...new Set(hits.slice(0, limit).map(h => h.id).filter(id => Number.isSafeInteger(id) && id > 0))];
    }
    const rows = db.getProjectMemoryContentPages(project.id, ids, offset, contentLimit);
    signal?.throwIfAborted();
    if (args.memory_id != null && !rows.length) throw new Error('Live memory not found in this project');
    const byId = new Map(rows.map(row => [row.id, row]));
    const sourceTruncations: McpSourceTruncation[] = [];
    const results = ids.flatMap(id => {
      const row = byId.get(id); if (!row) return [];
      const shown = Array.from(row.content).length, partial = shown < row.content_characters;
      if (partial) sourceTruncations.push({ technique: 'mcp-memory-content-page', inputSize: row.content_characters, outputSize: shown, unit: 'chars', recoverable: true });
      return [{ id, title: row.name, category: row.type, content: row.content, source: row.source, importance: row.importance,
        content_characters: row.content_characters, content_offset: offset, content_truncated: partial,
        ...(partial ? { recovery: { tool: 'search_memory', project_name: project.name, memory_id: id,
          content_offset: offset + shown < row.content_characters ? offset + shown : 0, content_limit: contentLimit, format: args.format } } : {}) }];
    });
    const empty = !results.length ? db.countAgentMemory('project', project.id) === 0
      ? 'No project memory yet. Use save_memory (or remember) to record one.'
      : 'No live memory matched this ranked page. Try broader terms.' : undefined;
    const note = 'Ranked live memories; restart content offsets after edits. Semantic owner availability does not prove vector participation.';
    const text = args.format === 'json' ? JSON.stringify({ query, total: results.length, source, semantic: source === 'semantic_owner',
      degraded_reason: degradedReason, results, ...(empty ? { message: empty } : {}), note })
      : [empty, ...results.map(r => `## ${r.title} [${r.category}]\n${r.content}` + (r.recovery ? '\nContinue: ' + JSON.stringify(r.recovery) : '')),
        ...(degradedReason ? ['[note: semantic memory owner unavailable; results are FTS-only: ' + degradedReason + ']'] : []), note].filter(Boolean).join('\n\n---\n\n');
    recordMemoryAccess(db, results.map(row => row.id), 'explicit_read');
    return sourceTruncations.length ? { text, sourceTruncations } : text;
  }),
});
