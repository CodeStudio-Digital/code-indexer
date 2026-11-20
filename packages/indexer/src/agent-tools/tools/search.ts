import { discoverLivePaths, type LivePathSource, type LivePaths } from '@mcp/indexer/indexer/live-paths.js';
import { grepProjectCode } from './live-grep.js';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { defineTool, type IndexTool } from '../tool.js';
import type { HybridSearchResult, SearchMode, SearchType } from '@mcp/shared/types.js';
import { withProject } from './_helpers.js';
import { renderDegradedTrailer, renderZeroResultDiagnostics } from './search-diagnostics.js';
import { codeNamespace } from '@mcp/shared/vector-namespace.js';

type DiskScanSource = LivePathSource;
export async function scanDiskForGrepDetailed(rootPath: string, glob: string | undefined, sources?: readonly DiskScanSource[], maxFiles = 2000): Promise<LivePaths> {
  return discoverLivePaths(sources?.length ? sources : [{ rootPath, prefix: '' }], { glob, maxFiles });
}

/** Compatibility wrapper for existing disk-fallback consumers. */
export async function scanDiskForGrep(
  rootPath: string,
  glob: string | undefined,
  sources?: readonly DiskScanSource[],
): Promise<string[]> {
  return (await scanDiskForGrepDetailed(rootPath, glob, sources)).paths;
}

function searchEvidence(result: HybridSearchResult): string {
  const fts = result.fts_rank === null ? null : `FTS #${result.fts_rank}`;
  const vector = result.vector_score === null
    ? null
    : `vector ${result.vector_score.toFixed(3)}`;
  if (fts && vector) return `hybrid · ${vector} · ${fts}`;
  return vector ?? fts ?? `rank score ${result.score.toPrecision(3)}`;
}

export function smallSemanticFilePreview(
  projectRoot: string,
  filePath: string,
  lineCount: number,
  read: (path: string, encoding: BufferEncoding) => string = boundedPreviewRead,
): string | null {
  if (lineCount > 40) return null;
  const root = resolve(projectRoot);
  const absolute = resolve(root, filePath);
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  try {
    const lines = read(absolute, 'utf-8').split(/\r?\n/).slice(0, 12);
    const preview = lines.map((line, index) => `${index + 1}\t${line}`).join('\n').slice(0, 900);
    return preview ? `Semantic preview (small file):\n${preview}` : null;
  } catch {
    return null;
  }
}

/** Index line counts may be stale: never allocate the entire current file. */
function boundedPreviewRead(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024) return '';
    const buffer = Buffer.allocUnsafe(4096);
    return buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0));
  } finally { closeSync(fd); }
}

const search = defineTool({
  name: 'search',
  tier: 'bootstrap',
  access: 'read',
  description: 'Hybrid code search. Ask a natural-language question with mode=auto to use vectors; use grep_code for exact identifiers or literals.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      query: { type: 'string', minLength: 1, maxLength: 4096 },
      mode: {
        type: 'string',
        enum: ['auto', 'fts', 'vector', 'hybrid'],
        description: 'Use auto by default. FTS is for exact identifiers/literals; vector/hybrid are diagnostic overrides for conceptual or cross-language retrieval.',
      },
      type: { type: 'string', enum: ['files', 'symbols', 'all'] },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
    required: ['project_name', 'query'],
  },
  handler: withProject(async (args, { db, hybridSearch, semanticSearchClient, semanticStore, signal }, project) => {
    signal?.throwIfAborted();
    // 'auto' lets the planner route: identifier-shaped → FTS (~10ms),
    // natural language → hybrid. Forcing 'hybrid' here made every symbol
    // lookup pay HyDE + multi-variant embedding + rerank for nothing.
    const requestedMode = (args.mode as SearchMode) ?? 'auto';
    const type = (args.type as SearchType) ?? 'all';
    const limit = Math.max(1, Math.min(100, Math.floor(Number(args.limit) || 20)));
    const query = String(args.query ?? '').trim();
    if (!query || query.length > 4096) throw new Error('query must contain 1–4096 characters');
    const sessionId = typeof args.__mcp_session_id === 'string'
      ? args.__mcp_session_id
      : undefined;
    const companySessionId = typeof args.__mcp_company_session_id === 'string'
      ? args.__mcp_company_session_id
      : undefined;
    const remote = requestedMode === 'fts'
      ? null
      : await semanticSearchClient.searchProject(project.id, query, {
          mode: requestedMode,
          type,
          limit,
          consumer: 'agent',
          sessionId,
          companySessionId,
          signal,
        });
    signal?.throwIfAborted();
    const searched = remote?.ok && remote.value
      ? remote.value
      : await hybridSearch.searchWithDiag(project.id, project.name, query, {
          // Explicit lexical fallback: the MCP process never owns vector or
          // ONNX resources, and a stopped desktop app must not break agents.
          mode: 'fts',
          type,
          limit,
          signal,
          telemetryContext: { requestId: randomUUID(), consumer: 'agent', sessionId, companySessionId },
        });
    signal?.throwIfAborted();
    const diagnostics = remote && !remote.ok
      ? {
          ...searched.diagnostics,
          vectorAvailable: false,
          embeddingAvailable: false,
          effectiveMode: 'fts' as const,
          fallback: true,
          vectorError: `localhost semantic owner unavailable: ${remote.error ?? 'unknown error'}`,
        }
      : searched.diagnostics;
    const results = searched.results;
    const structuredContent = {
      schemaVersion: 1,
      projectId: project.id,
      requestedMode,
      effectiveMode: diagnostics.effectiveMode ?? (remote?.ok ? null : 'fts'),
      generationUsed: diagnostics.generationUsed ?? null,
      freshness: {
        mode: 'indexed', snapshot: false,
        structuralRevision: diagnostics.structuralRevision ?? null,
        structuralRevisionAfter: diagnostics.structuralRevisionAfter ?? null,
        revisionStable: diagnostics.structuralRevisionStable ?? false,
      },
      coverage: { kind: 'ranked_top_k', limit, returned: results.length,
        vectorAvailable: diagnostics.vectorAvailable, embeddingAvailable: diagnostics.embeddingAvailable,
        fallback: diagnostics.fallback ?? false, fallbackReason: diagnostics.fallbackReason ?? diagnostics.vectorError ?? null },
      absenceConclusive: false,
      hits: results.map(r => {
        const d = r.data as unknown as Record<string, unknown>;
        return { type: r.type, id: r.id, path: r.type === 'file' ? d.path : d.file_path,
          line: d.line ?? null, endLine: d.end_line ?? null, name: d.name ?? null,
          score: r.score, ftsRank: r.fts_rank, vectorScore: r.vector_score,
          contentHash: d.content_hash ?? null };
      }),
    };
    if (results.length === 0) {
      const generation = semanticStore.listNamespaceGenerations({
        namespace: codeNamespace(project.id),
      })[0];
      return { structuredContent, text: renderZeroResultDiagnostics(requestedMode, diagnostics, () => ({
        files_total: db.countFiles(project.id),
        semantic_expected: generation?.expected_items ?? 0,
        semantic_indexed: generation?.indexed_items ?? 0,
        pending_delta_items: generation?.delta_items ?? 0,
      })) };
    }
    let semanticPreviews = 0;
    const body = results.map(r => {
      const d = r.data as unknown as Record<string, unknown>;
      if (r.type === 'file') {
        const preview = r.vector_score !== null && r.fts_rank === null && semanticPreviews < 3
          ? smallSemanticFilePreview(project.root_path, String(d.path), Number(d.line_count))
          : null;
        if (preview) semanticPreviews++;
        return [
          `## [file] ${d.path} (${searchEvidence(r)})`,
          `Language: ${d.language} | Lines: ${d.line_count}`,
          preview,
        ].filter(Boolean).join('\n');
      }
      return [
        `## [symbol] ${d.name} (${d.kind}) — ${searchEvidence(r)}`,
        `File: ${d.file_path}:${d.line ?? '?'}`,
        `Signature: ${d.signature ?? ''}`,
        d.comment ? `Description: ${d.comment}` : '',
        d.parent ? `Parent: ${d.parent}` : '',
      ].filter(Boolean).join('\n');
    }).join('\n\n');
    const trailer = requestedMode === 'fts' ? null : renderDegradedTrailer(diagnostics);
    return { structuredContent, text: trailer ? `${body}\n\n${trailer}` : body };
  }),
});

// `search_concepts` and `search_by_kind` were retired from the MCP surface
// (tool audit 2026-07, docs/audit/TOOL_AUDIT.md): 0 calls in telemetry — the
// `search` planner routes free-text and identifier queries, and grep_code
// covers exact-shape hunts, leaving no niche for the specialized variants.
const grep_code = defineTool({
  name: 'grep_code',
  tier: 'bootstrap',
  access: 'read',
  description: 'Search file contents with language/glob filters. Empty content results may include separately labeled filename hints. Results capped at max_results (default 20). Use literal=true for exact strings.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      pattern: { type: 'string' },
      literal: { type: 'boolean' },
      case_sensitive: { type: 'boolean' },
      language: { type: 'string' },
      glob: { type: 'string' },
      max_results: { type: 'number' },
    },
    required: ['project_name', 'pattern'],
  },
  handler: withProject(grepProjectCode),
});

export const searchTools: IndexTool[] = [search, grep_code];
