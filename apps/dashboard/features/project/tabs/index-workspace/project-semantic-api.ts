export type ProjectSemanticJobStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ProjectSemanticRoute {
  generationId: number;
  dbPath?: string;
  tableName?: string;
}

export interface ProjectSemanticNamespaceStatus {
  namespace: string;
  dbPath?: string;
  size_bytes?: number;
  active: ProjectSemanticRoute | null;
  building: ProjectSemanticRoute | null;
  expected_items: number;
  indexed_items: number;
  failed_items: number;
  delta_items: number;
  last_error: string | null;
}

export interface ProjectSemanticReindexJob {
  id: number;
  status: ProjectSemanticJobStatus;
  expected_items: number;
  processed_items: number;
  failed_items: number;
  error: string | null;
  updated_at: string;
}

export interface ProjectUnusedVectorCleanupResult {
  tables_removed: number;
  items_removed: number;
  databases_compacted: number;
  bytes_reclaimed: number;
  skipped_referenced: number;
  failures: Array<{ namespace: string; generation_id: number; error: string }>;
}

export type ProjectSemanticSearchMode = 'auto' | 'fts' | 'vector' | 'hybrid';
export type ProjectSemanticSearchType = 'all' | 'files' | 'symbols';

export interface ProjectSemanticSearchInput {
  query: string;
  mode: ProjectSemanticSearchMode;
  type: ProjectSemanticSearchType;
  limit: number;
}

export interface ProjectSemanticSearchResultItem {
  id: number;
  type: 'file' | 'symbol';
  score: number;
  fts_rank: number | null;
  vector_score: number | null;
  data: {
    path?: string;
    file_path?: string;
    name?: string;
    kind?: string;
    language?: string;
    line_count?: number;
    line?: number | null;
    signature?: string | null;
    comment?: string | null;
    parent?: string | null;
  };
}

export interface ProjectSemanticSearchDiagnostics {
  vectorAvailable: boolean;
  embeddingAvailable: boolean;
  requestedMode?: ProjectSemanticSearchMode;
  plannedMode?: 'fts' | 'vector' | 'hybrid';
  effectiveMode?: 'fts' | 'vector' | 'hybrid';
  generationUsed?: number;
  embedder?: string;
  reranker?: string;
  fallback?: boolean;
  fallbackReason?: string;
  queryVariants?: string[];
  vectorRawMatches?: number;
  vectorRehydrated?: number;
  vectorError?: string;
  ftsCount?: number;
  plannerMode?: 'fts' | 'vector' | 'hybrid';
  plannerReason?: string;
  recentFilesCount?: number;
  graphExpansionCount?: number;
  contentCount?: number;
  cacheHit?: boolean;
  totalTimeMs?: number;
  rerankerApplied?: boolean;
  rerankerCandidates?: number;
  rerankerReturned?: number;
  rerankerError?: string;
}

export interface ProjectSemanticSearchTestResult {
  results: ProjectSemanticSearchResultItem[];
  diagnostics: ProjectSemanticSearchDiagnostics;
}

export interface ProjectSemanticStatus {
  project_id: number;
  profiles: Array<{
    purpose: 'code' | 'knowledge';
    embedding_target: {
      kind: string;
      model?: string;
      revision?: string;
      dtype?: string;
    };
    reranker_target?: {
      kind: string;
      model?: string;
      revision?: string;
      dtype?: string;
    };
  }>;
  namespaces: ProjectSemanticNamespaceStatus[];
  reindex_job: ProjectSemanticReindexJob | null;
  /** Newer servers expose immutable generation targets separately from the
   * currently configured profile. Optional fields keep rolling upgrades safe. */
  active_generation?: {
    id: number;
    embedding_target: { kind: string; model?: string; revision?: string; dtype?: string };
    dimension?: number;
  } | null;
  building_generation?: {
    id: number;
    embedding_target: { kind: string; model?: string; revision?: string; dtype?: string };
    dimension?: number;
  } | null;
  resolved_reranker?: {
    model?: string;
    dtype?: string;
    execution_provider?: string;
    estimated_memory_bytes?: number;
    downgrade_reason?: string | null;
    last_latency_ms?: number | null;
  } | null;
}

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
  return body?.error ?? body?.message ?? `HTTP ${response.status}`;
}

async function expectOk(response: Response): Promise<Response> {
  if (!response.ok) throw new Error(await readError(response));
  return response;
}

export async function fetchProjectSemanticStatus(projectId: number): Promise<ProjectSemanticStatus> {
  const response = await expectOk(
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/semantic/status`),
  );
  return response.json() as Promise<ProjectSemanticStatus>;
}

export async function requestProjectSemanticReindex(
  projectId: number,
  action: 'start' | 'catchup' | 'resume' | 'rebuild' = 'start',
): Promise<ProjectSemanticReindexJob> {
  const response = await expectOk(
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/semantic/reindex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    }),
  );
  const body = await response.json() as { job: ProjectSemanticReindexJob };
  return body.job;
}

export async function cleanupProjectUnusedVectors(
  projectId: number,
): Promise<ProjectUnusedVectorCleanupResult> {
  const response = await expectOk(await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/semantic/vectors/cleanup-unused`,
    { method: 'POST' },
  ));
  const body = await response.json() as { result: ProjectUnusedVectorCleanupResult };
  return body.result;
}

/** Runs the same project search used by MCP, agents and Search Everywhere.
 * Cache is deliberately bypassed so this diagnostic action measures the real
 * embedding/vector/reranker path on every click. */
export async function testProjectSemanticSearch(
  projectId: number,
  input: ProjectSemanticSearchInput,
  signal?: AbortSignal,
): Promise<ProjectSemanticSearchTestResult> {
  const query = new URLSearchParams({
    q: input.query,
    mode: input.mode,
    type: input.type,
    limit: String(input.limit),
    supersessionKey: `semantic-test:p${projectId}`,
    bypassCache: '1',
  });
  const response = await expectOk(await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/search?${query.toString()}`,
    { signal },
  ));
  return response.json() as Promise<ProjectSemanticSearchTestResult>;
}

export function codeNamespaceStatus(
  status: ProjectSemanticStatus | null,
): ProjectSemanticNamespaceStatus | null {
  if (!status) return null;
  return status.namespaces.find((namespace) => namespace.namespace === `code:p${status.project_id}`) ?? null;
}

export function semanticCoveragePercent(status: ProjectSemanticNamespaceStatus | null): number {
  if (!status?.expected_items) return 0;
  return Math.min(100, Math.round((status.indexed_items / status.expected_items) * 100));
}

export function semanticWorkIsActive(status: ProjectSemanticStatus | null): boolean {
  const jobStatus = status?.reindex_job?.status;
  // `building` is a durable physical pointer, not an execution lease. Pending
  // markers also survive restart deliberately and become executable only when
  // the user clicks again. Only a running control/backfill job may disable the
  // recovery action and arm continuous polling.
  return jobStatus === 'running';
}
