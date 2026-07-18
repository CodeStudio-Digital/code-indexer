/**
 * Documentation tools — surface the project's RAG corpus (user-managed
 * "Documentação" page) through the MCP HTTP server so external agents
 * can search it the same way the in-house code-agent does.
 *
 * Backed by the same singleton (`getGlobalDocSearch()`) wired in
 * `apps/http-api/server.ts` during boot. When the MCP server runs as a
 * standalone stdio subprocess outside the http-api process (no wiring
 * happens there), the tool returns a clear error pointing the operator
 * at the right entry point — better than a silent empty result.
 */
import {
  defineTool,
  mcpAccess,
  type McpSourceTruncation,
  type McpTool,
  type McpToolOutput,
} from '../tool.js';
import {
  getGlobalDocSearch,
  type DocSearchBackend,
} from '@mcp/code-agent/tools/rag-search-docs.js';

function unavailable(): string {
  return JSON.stringify(
    {
      error: 'doc_search_unavailable',
      message:
        'Documentation search backend is not wired into this MCP server instance. ' +
        'Use the HTTP MCP endpoint mounted by apps/http-api instead — the standalone ' +
        'stdio binary does not own the doc index.',
    },
    null,
    2,
  );
}

function requirePositiveId(value: unknown): number | null {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? Math.trunc(id) : null;
}

function completeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

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
  name: 'rag_search_docs',
  tier: 'bootstrap',
  ...mcpAccess('read'),
  description:
    'Semantic + lexical search over indexed external documentation (Unity, frameworks, libraries, internal handbooks). Returns relevant doc sections with heading path, source URL/PDF, and a snippet.\n' +
    'USE: when you need authoritative information that is NOT in the project codebase — API references, framework concepts, library usage, third-party tooling.\n' +
    'USE: as a FIRST step before guessing or recalling. The corpus is fresher than your training cutoff and grounded in attached docs.\n' +
    "DON'T: use to search the current project's code — that's `search` / `grep_code`.\n" +
    'Pass `collection` to scope to a known collection name (visible in the dashboard); omit it to search globally.',
  // Doc search is read-only and runs against the indexed corpus only — no
  // filesystem or network side effects, so `mcp:read` is the right gate.
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural-language search query. Specific is better than broad.',
      },
      collection: {
        type: 'string',
        description: 'Optional collection name (matches dashboard sidebar). Omit to search globally.',
      },
      limit: {
        type: 'number',
        description: 'Max results to return. Default 8, capped at 100.',
      },
    },
    required: ['query'],
  },
  handler: async (args) => {
    const backend = getGlobalDocSearch();
    if (!backend) {
      // This branch fires when the MCP server is reached out-of-process
      // (e.g. someone hand-spawned the stdio binary). The HTTP transport
      // mounted in apps/http-api always has the singleton wired so the
      // path most external agents take works out of the box.
      return unavailable();
    }

    const query = String(args.query ?? '').trim();
    if (!query) {
      return JSON.stringify({ error: 'query is required' });
    }
    const limitRaw = typeof args.limit === 'number' ? args.limit : 8;
    const limit = Math.max(1, Math.min(100, Math.floor(limitRaw)));
    const collection =
      typeof args.collection === 'string' && args.collection.trim() ? args.collection.trim() : undefined;

    const result = await backend.search({ query, collection, limit });
    const sourceTruncations = searchOmissions(result);
    const text = completeJson(result);
    return sourceTruncations ? { text, sourceTruncations } satisfies McpToolOutput : text;
  },
});

const rag_read_doc = defineTool({
  name: 'rag_read_doc',
  tier: 'bootstrap',
  ...mcpAccess('read'),
  description:
    'Read indexed documentation in full by chunk_id from rag_search_docs. ' +
    "Default mode='chunk' returns the complete chunk and complete neighboring chunks. " +
    "Use mode='section' to return every size-split chunk in the same heading. No local output cap is applied.",
  inputSchema: {
    type: 'object',
    properties: {
      chunk_id: {
        type: 'number',
        description: 'A chunk_id returned by rag_search_docs or rag_doc_outline.',
      },
      mode: {
        type: 'string',
        enum: ['chunk', 'section'],
        description: "Default 'chunk'; use 'section' to reassemble the whole heading.",
      },
      window: {
        type: 'number',
        description: "Neighbor chunks on each side in mode='chunk'. Default 1; clamped to [0, 3].",
      },
    },
    required: ['chunk_id'],
  },
  handler: async (args) => {
    const backend = getGlobalDocSearch();
    if (!backend) return unavailable();
    const chunkId = requirePositiveId(args.chunk_id);
    if (chunkId == null) return completeJson({ error: 'chunk_id must be a positive number' });

    if (args.mode === 'section') {
      if (!backend.readSection) {
        return completeJson({ error: 'doc_section_read_unavailable' });
      }
      const section = await backend.readSection({ chunk_id: chunkId });
      return section
        ? completeJson(section)
        : completeJson({
            error: 'doc_chunk_not_found',
            chunk_id: chunkId,
            recovery: 'Run rag_search_docs again for fresh chunk_ids.',
          });
    }

    if (!backend.readChunk) return completeJson({ error: 'doc_chunk_read_unavailable' });
    const rawWindow = Number(args.window);
    const window = Number.isFinite(rawWindow)
      ? Math.max(0, Math.min(3, Math.trunc(rawWindow)))
      : 1;
    const read = await backend.readChunk({ chunk_id: chunkId, window });
    return read
      ? completeJson(read)
      : completeJson({
          error: 'doc_chunk_not_found',
          chunk_id: chunkId,
          recovery: 'Run rag_search_docs again for fresh chunk_ids.',
        });
  },
});

const rag_doc_outline = defineTool({
  name: 'rag_doc_outline',
  tier: 'bootstrap',
  ...mcpAccess('read'),
  description:
    'Browse indexed documentation structurally. Pass collection to return its complete source list, ' +
    'or source_id to return the complete heading tree with chunk_ids for rag_read_doc. No local output cap is applied.',
  inputSchema: {
    type: 'object',
    properties: {
      collection: {
        type: 'string',
        description: 'Collection name; returns every indexed source in the collection.',
      },
      source_id: {
        type: 'number',
        description: 'Source id returned by this tool; returns its complete heading tree.',
      },
    },
  },
  handler: async (args) => {
    const backend = getGlobalDocSearch();
    if (!backend) return unavailable();
    if (!backend.outline) return completeJson({ error: 'doc_outline_unavailable' });

    const sourceId = requirePositiveId(args.source_id);
    const collection = typeof args.collection === 'string' ? args.collection.trim() : '';
    if (sourceId == null && !collection) {
      return completeJson({ error: 'Pass collection or source_id.' });
    }
    const outline = await backend.outline(
      sourceId != null ? { source_id: sourceId } : { collection },
    );
    return outline
      ? completeJson(outline)
      : completeJson({
          error: 'doc_outline_not_found',
          ...(sourceId != null ? { source_id: sourceId } : { collection }),
        });
  },
});

export const docsTools: McpTool[] = [rag_search_docs, rag_read_doc, rag_doc_outline];
