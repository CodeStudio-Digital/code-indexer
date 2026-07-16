import type { SearchDiagnostics } from '@mcp/indexer/search/hybrid.js';
import type { AgentMemoryHit } from '@mcp/services/memory/agent-memory-service.js';
import type { HybridSearchResult, SearchMode, SearchType } from '@mcp/shared/types.js';
import type { IndexerConfig } from '@mcp/shared/utils/config.js';
import { requestMcpLocalServer } from './server-control.js';

type FetchLike = typeof fetch;

export interface SemanticClientResult<T> {
  ok: boolean;
  value: T | null;
  error: string | null;
}

export interface ProjectSemanticSearchResponse {
  results: HybridSearchResult[];
  diagnostics: SearchDiagnostics;
}

export interface MemorySemanticSearchResponse {
  results: AgentMemoryHit[];
}

export interface McpSemanticSearchClient {
  searchProject(
    projectId: number,
    query: string,
    options?: { mode?: SearchMode; type?: SearchType; limit?: number },
  ): Promise<SemanticClientResult<ProjectSemanticSearchResponse>>;
  searchProjectMemory(
    projectId: number,
    query: string,
    limit?: number,
  ): Promise<SemanticClientResult<MemorySemanticSearchResponse>>;
}

function failed<T>(error: string | null): SemanticClientResult<T> {
  return { ok: false, value: null, error: error ?? 'semantic server unavailable' };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseProjectResponse(body: unknown): ProjectSemanticSearchResponse | null {
  if (!isObject(body) || !Array.isArray(body.results) || !isObject(body.diagnostics)) return null;
  return body as unknown as ProjectSemanticSearchResponse;
}

function parseMemoryResponse(body: unknown): MemorySemanticSearchResponse | null {
  if (!isObject(body) || !Array.isArray(body.results)) return null;
  return body as unknown as MemorySemanticSearchResponse;
}

/**
 * Thin localhost RPC client used by the stdio/HTTP MCP processes. It never
 * opens sqlite-vec and never constructs an ONNX session: the http-api process
 * owns query embeddings, reranking and the semantic-vector worker.
 */
export function createMcpSemanticSearchClient(
  config: IndexerConfig,
  fetchImpl?: FetchLike,
): McpSemanticSearchClient {
  const request = (path: string) => requestMcpLocalServer(
    path,
    { method: 'GET' },
    { config, fetchImpl, timeoutMs: 20_000 },
  );

  return {
    async searchProject(projectId, query, options = {}) {
      const params = new URLSearchParams({ q: query });
      if (options.mode) params.set('mode', options.mode);
      if (options.type) params.set('type', options.type);
      if (options.limit !== undefined) params.set('limit', String(options.limit));
      const response = await request(`/api/projects/${projectId}/search?${params}`);
      if (!response.ok) return failed(response.error);
      const value = parseProjectResponse(response.body);
      return value
        ? { ok: true, value, error: null }
        : failed('semantic server returned an invalid search payload');
    },

    async searchProjectMemory(projectId, query, limit = 5) {
      const params = new URLSearchParams({ q: query, limit: String(limit) });
      const response = await request(`/api/projects/${projectId}/agent-memory/search?${params}`);
      if (!response.ok) return failed(response.error);
      const value = parseMemoryResponse(response.body);
      return value
        ? { ok: true, value, error: null }
        : failed('semantic server returned an invalid memory payload');
    },
  };
}
