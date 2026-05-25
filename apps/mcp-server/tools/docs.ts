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
import { defineTool, type McpTool } from '../tool.js';
import { getGlobalDocSearch } from '@mcp/code-agent/tools/rag-search-docs.js';

const rag_search_docs = defineTool({
  name: 'rag_search_docs',
  description:
    'Semantic + lexical search over indexed external documentation (Unity, frameworks, libraries, internal handbooks). Returns relevant doc sections with heading path, source URL/PDF, and a snippet.\n' +
    'USE: when you need authoritative information that is NOT in the project codebase — API references, framework concepts, library usage, third-party tooling.\n' +
    'USE: as a FIRST step before guessing or recalling. The corpus is fresher than your training cutoff and grounded in attached docs.\n' +
    "DON'T: use to search the current project's code — that's `search` / `grep_code`.\n" +
    'Pass `collection` to scope to a known collection name (visible in the dashboard); omit it to search globally.',
  // Doc search is read-only and runs against the indexed corpus only — no
  // filesystem or network side effects, so `mcp:read` is the right gate.
  scope: 'mcp:read',
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
        description: 'Max results to return. Default 8, capped at 30.',
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

    const query = String(args.query ?? '').trim();
    if (!query) {
      return JSON.stringify({ error: 'query is required' });
    }
    const limitRaw = typeof args.limit === 'number' ? args.limit : 8;
    const limit = Math.max(1, Math.min(30, Math.floor(limitRaw)));
    const collection =
      typeof args.collection === 'string' && args.collection.trim() ? args.collection.trim() : undefined;

    const result = await backend.search({ query, collection, limit });
    return JSON.stringify(
      {
        results: result.results.map((r) => ({
          chunk_id: r.chunk_id,
          collection: r.collection,
          source_id: r.source_id,
          source_uri: r.source_uri,
          heading_path: r.heading_path,
          snippet: r.snippet,
          score: r.score,
          summary: r.summary,
          concepts: r.concepts,
        })),
        diag: result.diag,
      },
      null,
      2,
    );
  },
});

export const docsTools: McpTool[] = [rag_search_docs];
