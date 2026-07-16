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
