/**
 * rag_search_docs — semantic + lexical search over indexed external
 * documentation (Unity, frameworks, libraries, …).
 *
 * The corpus is GLOBAL (not project-scoped): collections live in
 * `doc_collections` and are populated via the dashboard's "Documentação"
 * page. The agent calls this tool the way it'd call `mcp__search` over
 * code — but the hits come from the doc index, with `heading_path` and
 * the source URL/PDF for follow-up.
 *
 * The tool is read-only and parallel-safe, so it lands in
 * `BOOTSTRAP_TOOLS` (visible to all agent modes from turn 1).
 *
 * Backed by `DocHybridSearch` in `@mcp/services`. Wiring is via a process
 * singleton (`setGlobalDocSearch`) — same pattern as `setGlobalSubAgentCache`,
 * `setGlobalQualityClassifierPipeline`, etc. — to avoid threading another
 * dep through `ToolContext`.
 */
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';

/**
 * Shape of the search backend the tool relies on. Only the methods the
 * tool actually calls are listed here so the code-agent package stays
 * decoupled from `@mcp/services` at the type level.
 */
export interface DocSearchBackend {
  search(input: {
    query: string;
    collection?: string;
    limit?: number;
  }): Promise<{
    results: Array<{
      chunk_id: number;
      collection: string;
      source_id: number;
      source_uri: string | null;
      heading_path: string | null;
      snippet: string;
      score: number;
      summary: string | null;
      concepts: string[];
    }>;
    diag: {
      fts_hits: number;
      vector_hits: number;
      mode: 'hybrid' | 'fts' | 'vector';
      embedding_available: boolean;
      vector_available: boolean;
    };
  }>;
}

let globalBackend: DocSearchBackend | null = null;

/**
 * Wire the doc-search singleton — called from `apps/http-api/server.ts`
 * during boot. Pass `null` to detach (used in tests).
 */
export function setGlobalDocSearch(backend: DocSearchBackend | null): void {
  globalBackend = backend;
}

export function getGlobalDocSearch(): DocSearchBackend | null {
  return globalBackend;
}

export const ragSearchDocsTool: CoderTool = {
  name: 'rag_search_docs',
  description:
    'Semantic + lexical search over indexed external documentation (Unity, frameworks, libraries, internal handbooks). Returns the most relevant doc sections with their heading path, source URL/PDF, and a snippet.\n' +
    'USE: when you need authoritative information that is NOT in this project\'s codebase — API references, framework concepts, library usage, third-party tooling.\n' +
    'USE: as the FIRST step before guessing or recalling. The corpus is fresher than your training cutoff and grounded in the user\'s own attached docs.\n' +
    "DON'T: use to search the current project's code — that's `mcp__search` / `mcp__grep_code`.\n" +
    "DON'T: ask a follow-up the snippet already answers — read the snippet, cite it back to the user with the source.\n" +
    'Pass `collection` to scope to a known collection name (visible in the dashboard); omit it to search globally.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Natural-language query. Examples: "How does Rigidbody.AddForce work?", "Suspense boundary patterns in React 19", "shadcn select component API".',
      },
      collection: {
        type: 'string',
        description:
          'Optional. Restrict to a specific collection name (e.g. "unity-docs"). Omit to search across all collections.',
      },
      limit: {
        type: 'number',
        description: 'Max results to return. Default 5; clamped to [1, 20].',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  mutates: false,
  parallelSafe: true,
  riskLevel: 'read',
  handler: async (args, _ctx: ToolContext): Promise<ToolResult> => {
    const query = String(args.query ?? '').trim();
    if (!query) return err('query cannot be empty');
    if (!globalBackend) {
      return err(
        'rag_search_docs is not configured: the doc corpus backend is not wired into this process. Ask the user to ensure the Documentação feature is enabled.',
      );
    }
    const rawLimit = Number(args.limit);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(20, rawLimit)) : 5;
    const collection = typeof args.collection === 'string' ? args.collection.trim() : undefined;

    let response;
    try {
      response = await globalBackend.search({
        query,
        collection: collection || undefined,
        limit,
      });
    } catch (e) {
      return err(`doc search failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const { results, diag } = response;
    if (results.length === 0) {
      const hint = !diag.embedding_available
        ? ' (no embedder configured — only FTS5 was used)'
        : !diag.vector_available
          ? ' (vector store unavailable — only FTS5 was used)'
          : '';
      return ok(
        `No results for query "${query}"${collection ? ` in collection "${collection}"` : ''}${hint}. ` +
          'Try a broader query, drop the collection filter, or check that the collection has been indexed.',
      );
    }

    const header = `Found ${results.length} result${results.length === 1 ? '' : 's'} (mode=${diag.mode}, fts=${diag.fts_hits}, vector=${diag.vector_hits})`;
    const blocks = results.map((r, i) => {
      const lines: string[] = [];
      lines.push(`## [${i + 1}] ${r.heading_path ?? '(untitled)'} — ${r.collection}`);
      if (r.source_uri) lines.push(`Source: ${r.source_uri}`);
      lines.push(`Score: ${r.score.toFixed(4)}`);
      if (r.summary) lines.push(`Summary: ${r.summary}`);
      if (r.concepts.length > 0) lines.push(`Concepts: ${r.concepts.join(', ')}`);
      lines.push('', r.snippet);
      return lines.join('\n');
    });
    return ok(`${header}\n\n${blocks.join('\n\n---\n\n')}`);
  },
};

export const ragSearchDocsTools: CoderTool[] = [ragSearchDocsTool];
