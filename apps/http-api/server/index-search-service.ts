import { createContext, createSearchHandlers } from '@mcp/api-handlers';
import type { SearchConsumer } from '@mcp/api-bus';
import type { SearchMode, SearchType } from '@mcp/shared/types.js';
import { resolveSessionProjectAuthority } from '@mcp/session-storage/fs-store/index.js';
import type { AgentMemoryService } from '@mcp/services/memory/agent-memory-service.js';
import type { SemanticStore } from '@mcp/store/semantic-store.js';

/**
 * The slice of the server dependencies these functions use. Structural, so
 * this module (reached by the worker pools) never imports server/deps.ts.
 */
type IndexSearchDeps = Parameters<typeof createSearchHandlers>[0] & {
  sessionStore: { getSession(id: string): Promise<Parameters<typeof resolveSessionProjectAuthority>[0] | null> };
  agentMemoryService: Pick<AgentMemoryService, 'search'>;
  semanticStore: Pick<SemanticStore, 'listNamespaceGenerations'>;
  semanticCoordinator: {
    ensureMemoryNamespace(namespace: string): Promise<unknown>;
    catchUpMemoryNamespace(namespace: string): Promise<unknown>;
  };
};

const SEARCH_CONSUMERS = new Set<SearchConsumer>([
  'agent',
  'search_everywhere',
  'monaco',
  'semantic_test',
  'api',
  'cli',
  'benchmark',
  'unknown',
]);

export function searchConsumer(value: string | undefined): SearchConsumer {
  return value && SEARCH_CONSUMERS.has(value as SearchConsumer)
    ? value as SearchConsumer
    : 'api';
}

/** Session ids a search may be attributed to in telemetry. */
export interface TelemetryIds {
  sessionId?: string;
  companySessionId?: string;
}

/**
 * Keep an id only when that session exists and its project authority covers
 * the searched project. The HTTP route passes request headers; worker RPC
 * passes the claimed ids or the host's own (worker-index-handlers.ts).
 */
export async function validateTelemetryScope(
  deps: Pick<IndexSearchDeps, 'sessionStore' | 'db'>,
  projectId: number,
  ids: TelemetryIds,
): Promise<TelemetryIds | undefined> {
  const scope: TelemetryIds = {};
  for (const key of ['sessionId', 'companySessionId'] as const) {
    const id = ids[key]?.trim();
    if (!id || id.length > 128) continue;
    const session = await deps.sessionStore.getSession(id).catch(() => null);
    if (!session) continue;
    const authority = resolveSessionProjectAuthority(session, (candidateId) => {
      const project = deps.db.getProject(candidateId);
      return project && !project.is_synthetic
        ? {
            project_id: project.id,
            name: project.name,
            root_path: project.root_path,
          }
        : null;
    });
    if (!authority?.projects.some((project) => project.project_id === projectId)) continue;
    scope[key] = id;
  }
  return scope.sessionId || scope.companySessionId ? scope : undefined;
}

type MemoryHit = Awaited<ReturnType<AgentMemoryService['search']>>[number];
export type MemorySearchOutcome =
  | { status: 200; results: MemoryHit[] }
  | { status: 400 | 404; error: string };

/** Project memory search as `/api/projects/:id/agent-memory/search` answers it. */
export async function searchProjectMemory(
  deps: Pick<IndexSearchDeps, 'db' | 'agentMemoryService'>,
  projectId: number,
  rawQuery: string,
  requestedLimit: number,
  signal: AbortSignal,
): Promise<MemorySearchOutcome> {
  if (!deps.db.getProject(projectId)) return { status: 404, error: 'Not found' };
  const query = rawQuery.trim();
  if (!query) return { status: 200, results: [] };
  const limit = Math.min(50, Math.max(1, requestedLimit));
  if (query.length > 4096) return { status: 400, error: 'query exceeds 4096 characters' };
  signal.throwIfAborted();
  const results = await deps.agentMemoryService.search('project', projectId, query, limit, undefined, signal);
  signal.throwIfAborted();
  return { status: 200, results };
}

export type NamespaceReconcileOutcome =
  | { ok: true; namespace: string; scheduled: true; first_generation: boolean }
  | { ok: false; error: string };

/** Targeted catch-up (or first build) of one memory/snapshot namespace. */
export function scheduleNamespaceReconcile(
  deps: Pick<IndexSearchDeps, 'semanticStore' | 'semanticCoordinator'>,
  namespace: unknown,
): NamespaceReconcileOutcome {
  if (typeof namespace !== 'string'
    || !/^(?:snapshot:p\d+|memory:project:p\d+|memory:user)$/.test(namespace)) {
    return { ok: false, error: 'unsupported semantic namespace' };
  }
  const state = deps.semanticStore.listNamespaceGenerations({ namespace })[0];
  const firstGeneration = !state?.active_generation_id && !state?.building_generation_id;
  queueMicrotask(() => {
    // This route is already the operator's explicit remote-provider action.
    // Let it create the first generation for this one namespace instead of
    // forcing the global profile reindex to fan out over every project.
    const reconcile = firstGeneration
      ? deps.semanticCoordinator.ensureMemoryNamespace(namespace)
      : deps.semanticCoordinator.catchUpMemoryNamespace(namespace);
    void reconcile.catch((error) =>
      console.warn(`[semantic] targeted reconcile paused for ${namespace}: ${error instanceof Error ? error.message : String(error)}`));
  });
  return { ok: true, namespace, scheduled: true, first_generation: firstGeneration };
}

export interface ProjectSearchInput {
  projectId: number;
  query: string;
  mode?: SearchMode;
  type?: SearchType;
  limit?: number;
  consumer?: SearchConsumer;
}

/** What agent workers reach over RPC: the same functions the HTTP routes call. */
export interface IndexSearchService {
  projectSearch(input: ProjectSearchInput, ids: TelemetryIds, signal: AbortSignal): Promise<unknown>;
  memorySearch(projectId: number, query: string, limit: number, signal: AbortSignal): Promise<MemorySearchOutcome>;
  reconcile(namespace: unknown): NamespaceReconcileOutcome;
}

export function createIndexSearchService(deps: IndexSearchDeps): IndexSearchService {
  const search = createSearchHandlers(deps);
  return {
    async projectSearch(input, ids, signal) {
      const telemetryScope = await validateTelemetryScope(deps, input.projectId, ids);
      return search.project({ ...input, limit: input.limit ?? 20, bypassCache: false },
        createContext({ signal, clientInfo: { sourceType: 'internal' }, telemetryScope }));
    },
    memorySearch: (projectId, query, limit, signal) => searchProjectMemory(deps, projectId, query, limit, signal),
    reconcile: (namespace) => scheduleNamespaceReconcile(deps, namespace),
  };
}
