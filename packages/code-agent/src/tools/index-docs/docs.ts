/** Shared documentation corpus tools for HTTP and standalone stdio. */
import { defineTool, resolveProject, type DocTool, type McpSourceTruncation, type McpToolOutput } from './doc-tool.js';
import type { DocSearchBackend } from '@mcp/code-agent/tools/doc-search-types.js';
import { documentationBackend } from './doc-backend.js';
import { docInteger, docPageSchema, chunkOutput, sectionOutput, outlineOutput } from './doc-pages.js';
function searchOmissions(
  result: Awaited<ReturnType<DocSearchBackend['search']>>,
): McpSourceTruncation[] | undefined {
  const { results } = result;
  const truncated = results.filter((result) => (
    result.snippet_truncated === true
    && Number.isFinite(result.snippet_source_chars)
    && Number.isFinite(result.snippet_retained_chars)
    && Number(result.snippet_source_chars) > Number(result.snippet_retained_chars)
  ));
  const omissions: McpSourceTruncation[] = [];
  if (truncated.length > 0) {
    omissions.push({
      technique: 'docs-search-snippet-preview',
      inputSize: truncated.reduce((sum, entry) => sum + Number(entry.snippet_source_chars), 0),
      outputSize: truncated.reduce((sum, entry) => sum + Number(entry.snippet_retained_chars), 0),
      unit: 'chars',
      recoverable: true,
    });
  }

  const diag = result.diag as typeof result.diag & {
    results_before_limit?: number;
    results_truncated?: boolean;
  };
  const beforeLimit = Number(diag.results_before_limit);
  if (diag.results_truncated === true) {
    const exact = Number.isFinite(beforeLimit) && beforeLimit > results.length;
    omissions.push({
      technique: 'docs-search-result-limit',
      inputSize: exact ? beforeLimit : results.length + 1,
      ...(exact ? {} : { inputSizeExact: false }),
      outputSize: results.length,
      unit: 'items',
      recoverable: true,
    });
  }
  return omissions.length > 0 ? omissions : undefined;
}


const rag_search_docs = defineTool({
  name: 'rag_search_docs', tier: 'bootstrap', access: 'read',
  description: 'Search indexed documentation. HTTP uses its configured search backend; standalone stdio uses local lexical search (diag.mode). Results are previews: read chunk_id with rag_read_doc to recover full text. Optional project_name prefers linked collections; collection explicitly selects a corpus.',
  inputSchema: { type: 'object', properties: {
    query: { type: 'string', maxLength: 4096 }, collection: { type: 'string', maxLength: 512 },
    project_name: { type: 'string', description: 'Prefer documentation linked to this project.' },
    scope: { type: 'string', enum: ['project', 'all'] },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 8.' },
  }, required: ['query'] },
  handler: async (args, ctx) => {
    ctx.signal?.throwIfAborted();
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query || query.length > 4096) throw new Error('query must contain 1..4096 characters');
    if (args.scope != null && args.scope !== 'all' && args.scope !== 'project') throw new Error('Invalid scope');
    const limit = docInteger(args, 'limit', 8, 1, 100);
    const collection = typeof args.collection === 'string' ? args.collection.trim() || undefined : undefined;
    if (collection && collection.length > 512) throw new Error('collection exceeds 512 characters');
    const project = typeof args.project_name === 'string' && args.project_name.trim()
      ? resolveProject(ctx.db, args.project_name.trim()) : undefined;
    const result = await documentationBackend(ctx).search({ query, collection, limit,
      ...(project ? { project_id: project.id } : {}), ...(args.scope ? { scope: args.scope as 'all' | 'project' } : {}) }, ctx.signal);
    ctx.signal?.throwIfAborted();
    const sourceTruncations = searchOmissions(result);
    const text = JSON.stringify(result, null, 2);
    return sourceTruncations ? { text, sourceTruncations } satisfies McpToolOutput : text;
  },
});
const rag_read_doc = defineTool({
  name: 'rag_read_doc', tier: 'bootstrap', access: 'read',
  description: 'Read indexed documentation pages by chunk_id. Follow next_char_offset for long text, next_offset for section pages, and recovery for neighbor previews. Character offsets use Unicode code points. Counts/tokens refer to the current page; restart at zero after index changes.',
  inputSchema: { type: 'object', properties: {
    chunk_id: { type: 'integer', minimum: 1 }, mode: { type: 'string', enum: ['chunk', 'section'] },
    window: { type: 'integer', minimum: 0, maximum: 3, description: 'Neighbor previews per side, default 1.' },
    char_offset: { type: 'integer', minimum: 0 },
    max_chars: { type: 'integer', minimum: 1, maximum: 200000, description: 'Default 65536.' }, ...docPageSchema,
  }, required: ['chunk_id'] },
  handler: async (args, ctx) => {
    ctx.signal?.throwIfAborted();
    const chunk_id = docInteger(args, 'chunk_id', 0, 1, Number.MAX_SAFE_INTEGER);
    if (args.mode != null && args.mode !== 'section' && args.mode !== 'chunk') throw new Error('Invalid mode');
    const backend = documentationBackend(ctx);
    if (args.mode === 'section') {
      const offset = docInteger(args, 'offset', 0, 0, Number.MAX_SAFE_INTEGER), limit = docInteger(args, 'limit', 32, 1, 64);
      if (!backend.readSection) throw new Error('doc_section_read_unavailable');
      const section = await backend.readSection({ chunk_id, offset, limit }, ctx.signal);
      ctx.signal?.throwIfAborted();
      if (!section) throw new Error('doc_chunk_not_found: rerun rag_search_docs for fresh chunk_ids');
      return sectionOutput(section, chunk_id, limit);
    }
    const window = docInteger(args, 'window', 1, 0, 3), char_offset = docInteger(args, 'char_offset', 0, 0, Number.MAX_SAFE_INTEGER);
    const max_chars = docInteger(args, 'max_chars', 65536, 1, 200000);
    if (!backend.readChunk) throw new Error('doc_chunk_read_unavailable');
    const read = await backend.readChunk({ chunk_id, window, char_offset, max_chars }, ctx.signal);
    ctx.signal?.throwIfAborted();
    if (!read) throw new Error('doc_chunk_not_found: rerun rag_search_docs for fresh chunk_ids');
    return chunkOutput(read);
  },
});
const rag_doc_outline = defineTool({
  name: 'rag_doc_outline', tier: 'bootstrap', access: 'read',
  description: 'Browse a collection source list or source heading pages. Follow next_offset/recovery until exhausted. Counts refer to this page; a heading split across pages may appear on both. Restart at zero after index changes.',
  inputSchema: { type: 'object', properties: {
    collection: { type: 'string', maxLength: 512 }, source_id: { type: 'integer', minimum: 1 }, ...docPageSchema,
  } },
  handler: async (args, ctx) => {
    ctx.signal?.throwIfAborted();
    const source_id = args.source_id == null ? undefined : docInteger(args, 'source_id', 0, 1, Number.MAX_SAFE_INTEGER);
    const collection = typeof args.collection === 'string' ? args.collection.trim() : '';
    if (!source_id && (!collection || collection.length > 512)) throw new Error('Pass collection (1..512 characters) or source_id');
    const offset = docInteger(args, 'offset', 0, 0, Number.MAX_SAFE_INTEGER), limit = docInteger(args, 'limit', source_id ? 500 : 100, 1, 500);
    const input = { ...(source_id ? { source_id } : { collection }), offset, limit };
    const backend = documentationBackend(ctx);
    if (!backend.outline) throw new Error('doc_outline_unavailable');
    const outline = await backend.outline(input, ctx.signal);
    ctx.signal?.throwIfAborted();
    if (!outline) throw new Error('doc_outline_not_found');
    return outlineOutput(outline, input);
  },
});
export const docsTools: DocTool[] = [rag_search_docs, rag_read_doc, rag_doc_outline];
