import type { SearchDiagnostics } from '@mcp/indexer/search/hybrid.js';
import type { AgentMemoryHit } from '@mcp/services/memory/agent-memory-service.js';
import type { HybridSearchResult, SearchMode, SearchType } from '@mcp/shared/types.js';
import type { CatalogIntentRequest } from '../indexer/providers/catalog-intent.js';
import type { ModelPage } from '../indexer/providers/model-catalog-read.js';

/**
 * What every semantic owner client answers, whatever carries it (host RPC
 * for agent workers, HTTP for the live bench), and how its payload is
 * validated before a tool trusts it.
 */
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
  results: Array<Pick<AgentMemoryHit, 'id' | 'score'>>;
}

export interface McpSemanticSearchClient {
  searchCatalog?(request: CatalogIntentRequest, signal?: AbortSignal): Promise<SemanticClientResult<ModelPage>>;
  searchProject(
    projectId: number,
    query: string,
    options?: {
      mode?: SearchMode;
      type?: SearchType;
      limit?: number;
      consumer?: 'agent';
      sessionId?: string;
      companySessionId?: string;
      signal?: AbortSignal;
    },
  ): Promise<SemanticClientResult<ProjectSemanticSearchResponse>>;
  searchProjectMemory(
    projectId: number,
    query: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<SemanticClientResult<MemorySemanticSearchResponse>>;
}

export function failed<T>(error: string | null): SemanticClientResult<T> {
  return { ok: false, value: null, error: error ?? 'semantic server unavailable' };
}

/**
 * The client of a process that has no semantic owner: every read fails with
 * the default text above, so search and search_memory fall back to FTS.
 */
export const UNAVAILABLE_SEMANTIC_SEARCH_CLIENT: McpSemanticSearchClient = {
  searchProject: async () => failed(null),
  searchProjectMemory: async () => failed(null),
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseProjectResponse(body: unknown): ProjectSemanticSearchResponse | null {
  if (!isObject(body) || !Array.isArray(body.results) || !isObject(body.diagnostics)) return null;
  return body as unknown as ProjectSemanticSearchResponse;
}

export function parseMemoryResponse(body: unknown): MemorySemanticSearchResponse | null {
  if (!isObject(body) || !Array.isArray(body.results) || body.results.length > 50) return null;
  if (body.results.some(row => !isObject(row) || !Number.isSafeInteger(row.id) || Number(row.id) < 1
    || typeof row.score !== 'number' || !Number.isFinite(row.score))) return null;
  return body as unknown as MemorySemanticSearchResponse;
}
