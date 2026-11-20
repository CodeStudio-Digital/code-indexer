/**
 * docs_search — hybrid (FTS5 + vector) search over the doc corpus.
 *
 * Differences from the coder's `rag_search_docs`:
 *   - Exposes `use_rewrite` and `use_rerank` so the agent can dial cost up.
 *   - Returns a structured chunk list with `chunk_id` prominent (the
 *     agent uses these in follow-up `docs_read_chunk` calls).
 *   - Honors the optional `collections[]` scoping set on the run.
 */
import type { CoderTool } from "@mcp/code-agent/core/tool.js";
import { docPassageUri } from '@mcp/shared/doc-passage-uri.js';
import type { ToolResult } from "@mcp/agent-runtime-host/tool-result.js";
import { ok, err } from "@mcp/agent-runtime-host/tool-result.js";
import type { DocHybridSearch } from '@mcp/services/services/docs/index.js';
import { classifyConfidence } from '@mcp/services/services/docs/index.js';
import type { ResolveContext } from '@mcp/services/pipelines/index.js';
import type { DocsEvidenceLedger } from './evidence-ledger.js';

export interface DocsSearchToolDeps {
  scopeIds?: ReadonlySet<number>;
  collectionIdsByName?: ReadonlyMap<string, number>;
  docHybridSearch: DocHybridSearch;
  /** Caller-side resolve context, forwarded to the rewriter/reranker. */
  resolveContext?: ResolveContext;
  /** Optional caller-scoped collections — used when the agent omits collection. */
  scopedCollections?: string[];
  /** Increment-on-call counter the DocsAgent uses for telemetry. */
  onCall?: () => void;
  ledger?: DocsEvidenceLedger;
  subQuestionCount?: () => number;
}

export function makeDocsSearchTool(deps: DocsSearchToolDeps): CoderTool {
  return {
    name: 'docs_search',
    description:
      'Hybrid (FTS5 + vector) search over the indexed doc corpus. Returns up to N chunks ranked by relevance.\n' +
      'USE when you need to find passages that cover a topic, API, or concept.\n' +
      'USE `use_rewrite: true` for conceptual queries (expands synonyms via LLM).\n' +
      'Set `use_rerank: true` to request the configured cross-encoder for the candidate passages.\n' +
      'Both flags are cached and degrade to no-op when no binding is configured — safe to leave on.\n' +
      'When the snippet looks truncated or you need full context, follow up with docs_read_chunk.',
    source: 'native',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language query. Examples: "OAuth setup Next.js 15", "Rigidbody.AddForce ignoring sleep".',
        },
        collection: {
          type: 'string',
          description: 'Optional collection name (e.g. "nextjs-docs"). Omit to search across all (or the caller-scoped set).',
        },
        limit: {
          type: 'number',
          description: 'Max chunks to return. Default 8; clamped to [1, 20].',
        },
        use_rewrite: {
          type: 'boolean',
          description: 'Run query rewriter (variants merged via RRF). Default false.',
        },
        use_rerank: {
          type: 'boolean',
          description: 'Re-rank top-K via LLM before truncating. Default false.',
        },
        sub_question_index: {
          type: 'number',
          description: 'Zero-based index from docs_plan that this search is answering.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    mutates: false,
    parallelSafe: true,
    riskLevel: 'read',
    handler: async (args, ctx): Promise<ToolResult> => {
      ctx.signal?.throwIfAborted();
      if (deps.ledger && !deps.ledger.canSearch()) {
        return err(`search budget exhausted (${deps.ledger.maxSearches}); use the evidence already collected and finish.`);
      }
      deps.onCall?.();
      const query = String(args.query ?? '').trim();
      if (!query) return err('query cannot be empty');
      const rawLimit = Number(args.limit);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(8, rawLimit)) : 6;
      const subQuestionCount = Math.max(1, deps.subQuestionCount?.() ?? 1);
      const requestedSubQuestion = Number(args.sub_question_index);
      const subQuestion = Number.isFinite(requestedSubQuestion)
        ? Math.max(0, Math.min(subQuestionCount - 1, Math.trunc(requestedSubQuestion)))
        : 0;
      const requestedCollection =
        typeof args.collection === 'string' ? args.collection.trim() : undefined;
      if (deps.scopeIds?.size === 0 || (requestedCollection && deps.scopedCollections?.length &&
          !deps.scopedCollections.includes(requestedCollection))) return err('Collection outside this task’s documentation scope.');
      const collection =
        requestedCollection ||
        (deps.scopedCollections && deps.scopedCollections.length === 1
          ? deps.scopedCollections[0]
          : undefined);
      const useRewrite = args.use_rewrite === true;
      const useRerank = args.use_rerank === true;
      const fixedId = collection ? deps.collectionIdsByName?.get(collection) : undefined;
      if (collection && deps.collectionIdsByName && fixedId === undefined) return err('Collection unavailable for this task.');

      let response;
      try {
        response = await deps.docHybridSearch.search({
          query,
          collection: fixedId === undefined ? collection || undefined : undefined,
          ...(fixedId !== undefined ? { collection_ids: [fixedId] } : deps.scopeIds ? { collection_ids: [...deps.scopeIds] } : {}),
          limit,
          enhancements:
            useRewrite || useRerank
              ? { rewrite: useRewrite, rerank: useRerank }
              : undefined,
          resolveContext: deps.resolveContext,
          signal: ctx.signal,
        });
        ctx.signal?.throwIfAborted();
      } catch (e) {
        ctx.signal?.throwIfAborted();
        return err(`docs_search failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      const { results, diag } = response;
      const coverage = diag.vector_collections;
      const partial = coverage?.failed.length ? ` Vector retrieval completed in ${coverage.completed}/${coverage.attempted} collections.` : '';
      deps.ledger?.recordSearch(subQuestion, results.map((r) => r.chunk_id));
      if (results.length === 0) {
        if (partial) return ok('Search coverage is incomplete.' + partial);
        const hint = !diag.embedding_available
          ? ' (no embedder configured — FTS5 only)'
          : !diag.vector_available
            ? ' (vector store unavailable — FTS5 only)'
            : '';
        return ok(
          `No results for "${query}"${collection ? ` in collection "${collection}"` : ''}${hint}. ` +
            'Try a broader query, drop the collection filter, or accept that the docs don\'t cover this.',
        );
      }

      const header = `Found ${results.length} result${results.length === 1 ? '' : 's'} ` +
        `(mode=${diag.mode}, fts=${diag.fts_hits}, vector=${diag.vector_hits}` +
        (diag.rewrite_used ? `, rewrite=${diag.rewrite_variants ?? 1}` : '') +
        (diag.rerank_used ? `, rerank+, dropped=${diag.rerank_dropped ?? 0}` : '') +
        ')' + partial;

      const blocks = results.map((r, i) => {
        const lines: string[] = [];
        lines.push(`## [${i + 1}] chunk_id=${r.chunk_id} — ${r.heading_path ?? '(untitled)'} — ${r.collection}`);
        if (r.source_uri) lines.push(`Source: ${docPassageUri(r.source_uri, r.anchor)}`);
        // Prefer the calibrated relevance (present when use_rerank ran); fall
        // back to the opaque RRF score, clearly flagged as uncalibrated.
        if (r.relevance != null) {
          lines.push(`Relevance: ${r.relevance.toFixed(2)} (${classifyConfidence(r.relevance, r.relevance_source)})`);
        } else {
          lines.push(`Score: ${r.score.toFixed(4)} (uncalibrated)`);
        }
        if (r.summary) lines.push(`Summary: ${r.summary}`);
        if (r.concepts.length > 0) lines.push(`Concepts: ${r.concepts.join(', ')}`);
        lines.push('', r.snippet);
        return lines.join('\n');
      });
      return ok(`${header}\n\n${blocks.join('\n\n---\n\n')}`);
    },
  };
}
