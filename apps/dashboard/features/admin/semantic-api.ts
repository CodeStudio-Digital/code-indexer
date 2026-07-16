export type SemanticProfilePurpose = 'code' | 'knowledge';

export type SemanticTargetKind = 'onnx' | 'local_http' | 'provider' | 'disabled';

export type SemanticOnnxDtype = 'q8' | 'q4' | 'fp16' | 'fp32';

export type SemanticTarget =
  | {
      kind: 'onnx';
      model: string;
      revision?: string;
      pooling?: 'mean' | 'cls';
      normalize?: boolean;
      queryTemplate?: string;
      documentTemplate?: string;
      maxTokens?: number;
      dtype?: SemanticOnnxDtype;
    }
  | {
      kind: 'local_http';
      baseUrl: string;
      model: string;
      protocol: 'openai-embeddings' | 'cohere-rerank' | 'openai-rerank';
    }
  | {
      kind: 'provider';
      providerId: string;
      model: string;
      protocol:
        | 'openai-embeddings'
        | 'cohere-rerank'
        | 'openai-rerank'
        | 'cloudflare'
        | 'bedrock';
    }
  | { kind: 'disabled' };

export interface SemanticProfileView {
  purpose: SemanticProfilePurpose;
  embedding_target: SemanticTarget;
  reranker_target: SemanticTarget;
  created_at?: string;
  updated_at?: string;
}

export interface SemanticModelView {
  id: string;
  capability: 'embedding' | 'rerank';
  source: 'default' | 'detected' | 'custom';
  provider_id?: string | null;
  model_id: string;
  config?: Record<string, unknown>;
  dimensions?: number | null;
  dimension?: number | null;
  status?: 'unknown' | 'ready' | 'error';
  last_probe_at?: string | null;
  last_probe_error?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface SemanticProbeResult {
  ok: boolean;
  error?: string;
  latency_ms?: number;
  dimensions?: number;
  model?: string;
}

export interface SemanticRerankerDiagnosticsView {
  policy: 'auto' | 'explicit';
  requested_model: string;
  resolved_model: string | null;
  dtype: string;
  estimated_peak_bytes: number;
  reserve_bytes: number;
  execution_provider: string;
  downgrade_reason: string | null;
  last_latency_ms: number | null;
  enabled: boolean;
  total_memory_bytes: number;
  available_memory_bytes: number;
  cpu_cores: number;
  active: boolean;
  queued: number;
}

export interface SemanticRerankerStatusView {
  target_kind: SemanticTargetKind | 'missing';
  diagnostics: SemanticRerankerDiagnosticsView | null;
  error: string | null;
}

export interface SemanticGenerationView {
  id: string | number;
  purpose: SemanticProfilePurpose;
  fingerprint?: string;
  embedding_target?: SemanticTarget;
  dimension?: number | null;
  status: string;
  expected_items?: number;
  indexed_items?: number;
  failed_items?: number;
  error?: string | null;
  created_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface SemanticJobView {
  id: number;
  generation_id: number | null;
  namespace: string;
  kind: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  expected_items: number;
  processed_items: number;
  failed_items: number;
  error: string | null;
  updated_at: string;
}

export interface SemanticUnusedVectorCleanupResult {
  tables_removed: number;
  items_removed: number;
  databases_compacted: number;
  bytes_reclaimed: number;
  skipped_referenced: number;
  failures: Array<{ namespace: string; generation_id: number; error: string }>;
}

/** Durable `pending` rows may be waiting for an explicit post-restart wake-up.
 * Only `running` proves that a dispatcher/worker currently owns the job. */
export function semanticJobIsExecuting(job: SemanticJobView | null | undefined): boolean {
  return job?.status === 'running';
}

export interface SemanticProjectView {
  id: number;
  name: string;
  root_path?: string;
}

export interface SemanticVectorRouteView {
  namespace: string;
  purpose: SemanticProfilePurpose;
  scope: 'code' | 'snapshot' | 'project_memory' | 'docs' | 'user_memory';
  projectId: number | null;
  collectionId: number | null;
  generationId: number;
  dbPath: string;
  tableName: string;
}

export interface SemanticNamespaceStatusView {
  namespace: string;
  purpose: SemanticProfilePurpose;
  dbPath: string;
  size_bytes: number;
  active: SemanticVectorRouteView | null;
  building: SemanticVectorRouteView | null;
  expected_items: number;
  indexed_items: number;
  failed_items: number;
  delta_items: number;
  last_error: string | null;
  updated_at: string | null;
}

export interface ProjectSemanticStatusView {
  project_id: number;
  profiles: SemanticProfileView[];
  namespaces: SemanticNamespaceStatusView[];
  reindex_job?: Pick<SemanticJobView,
    'id' | 'status' | 'expected_items' | 'processed_items' | 'failed_items' | 'error' | 'updated_at'> | null;
}

export interface ProjectSemanticStatusResult {
  project: SemanticProjectView;
  status: ProjectSemanticStatusView | null;
  error: string | null;
}

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as
    | { error?: string; message?: string }
    | null;
  return body?.error ?? body?.message ?? `HTTP ${response.status}`;
}

async function expectOk(response: Response): Promise<Response> {
  if (!response.ok) throw new Error(await readError(response));
  return response;
}

export async function fetchSemanticProfiles(): Promise<SemanticProfileView[]> {
  const response = await expectOk(await fetch('/api/admin/semantic/profiles'));
  const body = (await response.json()) as { profiles?: SemanticProfileView[] };
  return body.profiles ?? [];
}

export async function saveSemanticProfile(
  purpose: SemanticProfilePurpose,
  input: Pick<SemanticProfileView, 'embedding_target' | 'reranker_target'>,
  confirmFp32 = false,
): Promise<SemanticProfileView> {
  const response = await expectOk(
    await fetch(`/api/admin/semantic/profiles/${encodeURIComponent(purpose)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, confirm_fp32: confirmFp32 }),
    }),
  );
  const body = (await response.json()) as
    | SemanticProfileView
    | { profile: SemanticProfileView };
  return 'profile' in body ? body.profile : body;
}

export async function fetchSemanticModels(
  capability: 'embedding' | 'rerank',
  providerId?: string,
): Promise<SemanticModelView[]> {
  const params = new URLSearchParams({ capability });
  if (providerId) params.set('providerId', providerId);
  const response = await expectOk(
    await fetch(`/api/admin/semantic/models?${params.toString()}`),
  );
  const body = (await response.json()) as { models?: SemanticModelView[] };
  return body.models ?? [];
}

export async function probeSemanticTarget(
  capability: 'embedding' | 'rerank',
  target: SemanticTarget,
  confirmFp32 = false,
): Promise<SemanticProbeResult> {
  const response = await expectOk(
    await fetch('/api/admin/semantic/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability, target, confirm_fp32: confirmFp32 }),
    }),
  );
  const body = (await response.json()) as
    | SemanticProbeResult
    | { result: SemanticProbeResult };
  return 'result' in body ? body.result : body;
}

export async function fetchSemanticGenerations(): Promise<{
  generations: SemanticGenerationView[];
  storage: SemanticNamespaceStatusView[];
  jobs: SemanticJobView[];
  rerankers: Record<SemanticProfilePurpose, SemanticRerankerStatusView>;
}> {
  const response = await expectOk(await fetch('/api/admin/semantic/generations'));
  const body = (await response.json()) as {
    generations?: SemanticGenerationView[];
    storage?: SemanticNamespaceStatusView[];
    jobs?: SemanticJobView[];
    rerankers?: Partial<Record<SemanticProfilePurpose, SemanticRerankerStatusView>>;
  };
  const missingReranker = (): SemanticRerankerStatusView => ({
    target_kind: 'missing',
    diagnostics: null,
    error: null,
  });
  return {
    generations: body.generations ?? [],
    storage: body.storage ?? [],
    jobs: body.jobs ?? [],
    rerankers: {
      code: body.rerankers?.code ?? missingReranker(),
      knowledge: body.rerankers?.knowledge ?? missingReranker(),
    },
  };
}

export async function fetchProjectSemanticStatuses(
  concurrency = 4,
): Promise<ProjectSemanticStatusResult[]> {
  const projectsResponse = await expectOk(await fetch('/api/projects'));
  const projects = (await projectsResponse.json()) as SemanticProjectView[];
  const results: ProjectSemanticStatusResult[] = new Array(projects.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < projects.length) {
      const index = cursor++;
      const project = projects[index];
      try {
        const response = await expectOk(
          await fetch(`/api/projects/${encodeURIComponent(project.id)}/semantic/status`),
        );
        results[index] = {
          project,
          status: (await response.json()) as ProjectSemanticStatusView,
          error: null,
        };
      } catch (error) {
        results[index] = {
          project,
          status: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), projects.length) }, worker),
  );
  return results;
}

export async function reindexSemanticProfile(purpose: SemanticProfilePurpose): Promise<void> {
  await expectOk(
    await fetch(`/api/admin/semantic/profiles/${encodeURIComponent(purpose)}/reindex`, {
      method: 'POST',
    }),
  );
}

export async function cleanupUnusedSemanticVectors(): Promise<SemanticUnusedVectorCleanupResult> {
  const response = await expectOk(await fetch('/api/admin/semantic/vectors/cleanup-unused', {
    method: 'POST',
  }));
  const body = await response.json() as { result: SemanticUnusedVectorCleanupResult };
  return body.result;
}

/**
 * Explicitly build only the code namespace owned by one project.
 *
 * This is intentionally separate from profile save and application startup:
 * neither of those actions is allowed to fan out across registered projects.
 */
export async function reindexProjectSemanticCode(
  projectId: number,
  action: 'start' | 'catchup' | 'resume' | 'rebuild' = 'rebuild',
): Promise<void> {
  await expectOk(
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/semantic/reindex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    }),
  );
}
