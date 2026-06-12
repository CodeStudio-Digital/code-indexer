/**
 * rag_search_docs — semantic + lexical search over indexed external
 * documentation (Unity, frameworks, libraries, …).
 *
 * Collections live in `doc_collections` and are populated via the
 * dashboard's "Documentação" page. INGESTION is global, but RETRIEVAL is
 * project-scoped by default since migration 134: the backend filters to
 * the collections linked to the session's project (`scope:'project'`,
 * passing `ctx.projectId`), falling back to the whole corpus when the
 * project has no links. The agent calls this tool the way it'd call
 * `mcp__search` over code — but the hits come from the doc index, with
 * `heading_path`, the source URL/PDF and a `chunk_id` that feeds
 * `rag_read_doc` for the full section.
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
    /** 'project' (default) = prefer project-linked collections; 'all' = global. */
    scope?: 'project' | 'all';
    /** Session's project id — lets the backend resolve linked collections. */
    project_id?: number;
  }): Promise<{
    results: Array<{
      chunk_id: number;
      collection: string;
      source_id: number;
      source_uri: string | null;
      heading_path: string | null;
      snippet: string;
      /** Raw fusion score — opaque. Prefer `relevance` when present. */
      score: number;
      /** Calibrated 0-1 relevance from the reranker; null when uncalibrated. */
      relevance: number | null;
      summary: string | null;
      concepts: string[];
    }>;
    diag: {
      fts_hits: number;
      vector_hits: number;
      mode: 'hybrid' | 'fts' | 'vector';
      embedding_available: boolean;
      vector_available: boolean;
      /** Calibrated scoring ran and nothing cleared the relevance bar. */
      no_good_match?: boolean;
      /** Best calibrated relevance seen (even when below the bar). */
      top_relevance?: number | null;
      /** 'project' when filtered to project-linked collections. */
      scope?: 'project' | 'all';
      /** Names of the collections searched when scope === 'project'. */
      scoped_collections?: string[];
    };
  }>;
  /**
   * Full-content read of one chunk + its neighbors — backs `rag_read_doc`.
   * Optional so older backend wirings keep type-checking; the tool emits a
   * clear "not available" error when absent. Null = chunk id not found.
   */
  readChunk?(input: { chunk_id: number; window?: number }): Promise<DocChunkRead | null>;
}

export interface DocChunkNeighborRef {
  chunk_id: number;
  ord: number;
  heading_path: string | null;
  content: string;
  token_count: number;
}

export interface DocChunkRead {
  chunk: {
    chunk_id: number;
    collection: string;
    source_id: number;
    source_uri: string | null;
    heading_path: string | null;
    content: string;
    token_count: number;
    summary: string | null;
    concepts: string[];
  };
  /** Neighbors by `ord` within the same source, ascending. */
  prev: DocChunkNeighborRef[];
  next: DocChunkNeighborRef[];
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
    'Semantic + lexical search over indexed external documentation (Unity, frameworks, libraries, internal handbooks). Returns the most relevant doc sections with their heading path, source URL/PDF, a snippet, and a `chunk_id` — pass that to `rag_read_doc` to read any section in full.\n' +
    'Each result carries a calibrated Relevance (0-1, shown high/medium/low). When the corpus has nothing relevant, the tool SAYS SO explicitly — treat that as a real answer; do NOT fabricate from a weak hit.\n' +
    'By default the search is scoped to the collections linked to this project (falling back to the whole corpus when none are linked); pass scope:"all" to always search everything.\n' +
    'USE: when you need authoritative information that is NOT in this project\'s codebase — API references, framework concepts, library usage, third-party tooling.\n' +
    'USE: as the FIRST step before guessing or recalling. The corpus is fresher than your training cutoff and grounded in the user\'s own attached docs.\n' +
    "DON'T: use to search the current project's code — that's `mcp__search` / `mcp__grep_code`.\n" +
    "DON'T: ask a follow-up the snippet already answers — read the snippet (or rag_read_doc the chunk), cite it back to the user with the source.",
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
          'Optional. Restrict to a specific collection name (e.g. "unity-docs"). Omit to use the default project scoping.',
      },
      limit: {
        type: 'number',
        description: 'Max results to return. Default 5; clamped to [1, 20].',
      },
      scope: {
        type: 'string',
        enum: ['project', 'all'],
        description:
          'Default "project": search only the collections linked to this project (global fallback when none are linked). Use "all" to search the entire corpus.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  mutates: false,
  parallelSafe: true,
  riskLevel: 'read',
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
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
    const scope = args.scope === 'all' ? 'all' : 'project';

    let response;
    try {
      response = await globalBackend.search({
        query,
        collection: collection || undefined,
        limit,
        scope,
        project_id: ctx.projectId,
      });
    } catch (e) {
      return err(`doc search failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const { results, diag } = response;
    // When the backend filtered to project-linked collections, say WHICH
    // ones — it makes empty results actionable (retry with scope:'all').
    const scopeNote = diag.scope === 'project'
      ? ` Scoped to this project's linked collections (${(diag.scoped_collections ?? []).join(', ')}) — retry with scope:"all" to search the entire corpus.`
      : '';
    // Honest "no good match": the reranker scored everything below the
    // relevance bar. Surface that as a real answer so the agent doesn't
    // cite a weak hit as if it were authoritative.
    if (diag.no_good_match) {
      const best = typeof diag.top_relevance === 'number'
        ? ` The closest match scored ${diag.top_relevance.toFixed(2)}, below the relevance bar.`
        : '';
      return ok(
        `No sufficiently relevant documentation for "${query}"${collection ? ` in collection "${collection}"` : ''}.${best}` +
          scopeNote +
          " Don't guess from a weak match — broaden the query, or tell the user the docs don't cover this. For broad multi-section questions, docs_deep_research runs a cited research pass.",
      );
    }
    if (results.length === 0) {
      const hint = !diag.embedding_available
        ? ' (no embedder configured — only FTS5 was used)'
        : !diag.vector_available
          ? ' (vector store unavailable — only FTS5 was used)'
          : '';
      return ok(
        `No results for query "${query}"${collection ? ` in collection "${collection}"` : ''}${hint}.` +
          scopeNote +
          ' Try a broader query, or check that the collection has been indexed.',
      );
    }

    const scopeTag = diag.scope === 'project'
      ? `, scope=project (${(diag.scoped_collections ?? []).join(', ')})`
      : '';
    const header = `Found ${results.length} result${results.length === 1 ? '' : 's'} (mode=${diag.mode}, fts=${diag.fts_hits}, vector=${diag.vector_hits}${scopeTag})`;
    const blocks = results.map((r, i) => {
      const lines: string[] = [];
      lines.push(`## [${i + 1}] ${r.heading_path ?? '(untitled)'} — ${r.collection} (chunk_id: ${r.chunk_id})`);
      if (r.source_uri) lines.push(`Source: ${r.source_uri}`);
      // Prefer the calibrated relevance; fall back to the opaque RRF score
      // (clearly flagged) when rerank didn't run.
      if (typeof r.relevance === 'number') {
        lines.push(`Relevance: ${r.relevance.toFixed(2)} (${band(r.relevance)})`);
      } else {
        lines.push(`Score: ${r.score.toFixed(4)} (uncalibrated)`);
      }
      if (r.summary) lines.push(`Summary: ${r.summary}`);
      if (r.concepts.length > 0) lines.push(`Concepts: ${r.concepts.join(', ')}`);
      lines.push('', r.snippet);
      return lines.join('\n');
    });
    const footer = 'Snippets are truncated — use rag_read_doc({chunk_id}) to read any section in full (with surrounding sections).';
    return ok(`${header}\n\n${blocks.join('\n\n---\n\n')}\n\n${footer}`);
  },
};

/**
 * Coarse confidence band for display. Kept local (mirrors the bands in
 * `@mcp/services` relevance-policy) so this tool stays decoupled from
 * `@mcp/services` — presentation is a tool concern, policy is not.
 */
function band(relevance: number): string {
  if (relevance >= 0.75) return 'high';
  if (relevance >= 0.55) return 'medium';
  return 'low';
}

export const ragSearchDocsTools: CoderTool[] = [ragSearchDocsTool];
