/**
 * API client for pipeline_provider_bindings + their static catalog.
 *
 * Calls the routes mounted by
 * `apps/http-api/server/routes/admin/pipeline-bindings.ts`.
 */

export type BindingScopeType = 'global' | 'template' | 'session';

export interface PipelineCatalogEntry {
  pipelineName: string;
  bindingRole: string;
  description: string;
  recommendedDefault?: {
    providerKind: string;
    modelHint: string;
    config?: Record<string, unknown>;
  };
  comingSoon?: boolean;
  introducedInPhase: string;
}

export interface PipelineBinding {
  id: number;
  pipeline_name: string;
  binding_role: string;
  provider_id: string;
  model_id: string;
  model_mode: string;
  config: Record<string, unknown>;
  scope_type: BindingScopeType;
  scope_id: number | null;
  enabled: boolean;
  priority: number;
  created_at: string;
  updated_at: string;
  // Enriched fields (server-side):
  provider_name: string | null;
  provider_kind: string | null;
  provider_enabled: boolean;
  catalog_description: string | null;
}

export interface BindingTestResult {
  ok: boolean;
  reason?: string;
  provider?: { id: string; name: string; kind: string };
  model?: { model_id: string; mode: string; name: string };
  config?: Record<string, unknown>;
  provider_id?: string;
  model_id?: string;
  model_mode?: string;
  known_models?: Array<{ model_id: string; mode: string }>;
}

export interface ResolvePreview {
  ok: boolean;
  resolved: null | {
    provider_id: string;
    provider_name: string;
    provider_kind: string;
    model_id: string;
    model_mode: string;
    config: Record<string, unknown>;
    resolved_from: 'session' | 'template' | 'global' | 'fallback';
    binding_id: number | null;
  };
  ctx: { sessionId?: number; companySessionId?: number; templateId?: number };
}

export interface UpsertBindingInput {
  pipeline_name: string;
  binding_role: string;
  provider_id: string;
  model_id: string;
  model_mode?: string;
  config?: Record<string, unknown>;
  scope_type: BindingScopeType;
  scope_id?: number | null;
  enabled?: boolean;
  priority?: number;
}

export async function fetchBindings(opts: {
  pipelineName?: string;
  scopeType?: BindingScopeType;
  scopeId?: number;
  enabledOnly?: boolean;
} = {}): Promise<{ bindings: PipelineBinding[]; catalog: PipelineCatalogEntry[] }> {
  const params = new URLSearchParams();
  if (opts.pipelineName) params.set('pipeline_name', opts.pipelineName);
  if (opts.scopeType)    params.set('scope_type', opts.scopeType);
  if (opts.scopeId != null) params.set('scope_id', String(opts.scopeId));
  if (opts.enabledOnly)  params.set('enabled_only', '1');
  const r = await fetch(`/api/admin/pipeline-bindings?${params.toString()}`);
  if (!r.ok) throw new Error(`Failed to fetch bindings: ${r.status}`);
  return (await r.json()) as { bindings: PipelineBinding[]; catalog: PipelineCatalogEntry[] };
}

export async function fetchCatalog(): Promise<{ catalog: PipelineCatalogEntry[]; grouped: Array<{ pipeline_name: string; roles: PipelineCatalogEntry[] }> }> {
  const r = await fetch('/api/admin/pipeline-bindings/catalog');
  if (!r.ok) throw new Error(`Failed to fetch catalog: ${r.status}`);
  return (await r.json()) as { catalog: PipelineCatalogEntry[]; grouped: Array<{ pipeline_name: string; roles: PipelineCatalogEntry[] }> };
}

export async function upsertBinding(input: UpsertBindingInput): Promise<{ id: number; binding: PipelineBinding | null }> {
  const r = await fetch('/api/admin/pipeline-bindings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const err = (await r.json()) as { error?: string; details?: string[] };
    throw new Error(err.details?.join(', ') ?? err.error ?? `HTTP ${r.status}`);
  }
  return (await r.json()) as { id: number; binding: PipelineBinding | null };
}

export type PatchBindingInput = Partial<UpsertBindingInput>;

export async function patchBinding(id: number, patch: PatchBindingInput): Promise<{ binding: PipelineBinding | null }> {
  const r = await fetch(`/api/admin/pipeline-bindings/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string; details?: string[]; detail?: string };
    throw new Error(err.details?.join(', ') ?? err.detail ?? err.error ?? `HTTP ${r.status}`);
  }
  return (await r.json()) as { binding: PipelineBinding | null };
}

export async function deleteBinding(id: number): Promise<void> {
  const r = await fetch(`/api/admin/pipeline-bindings/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

export async function testBinding(id: number): Promise<BindingTestResult> {
  const r = await fetch(`/api/admin/pipeline-bindings/${id}/test`, { method: 'POST' });
  return (await r.json()) as BindingTestResult;
}

export async function previewResolution(opts: {
  pipelineName: string;
  bindingRole: string;
  sessionId?: number;
  companySessionId?: number;
  templateId?: number;
}): Promise<ResolvePreview> {
  const params = new URLSearchParams();
  params.set('pipeline_name', opts.pipelineName);
  params.set('binding_role', opts.bindingRole);
  if (opts.sessionId != null)         params.set('session_id', String(opts.sessionId));
  if (opts.companySessionId != null)  params.set('company_session_id', String(opts.companySessionId));
  if (opts.templateId != null)        params.set('template_id', String(opts.templateId));
  const r = await fetch(`/api/admin/pipeline-bindings/resolve?${params.toString()}`);
  return (await r.json()) as ResolvePreview;
}

// ─── Bulk operations ─────────────────────────────────────────────────────

export interface BulkClearOptions {
  /**
   * Restrict the wipe to a single scope. When omitted, the call wipes
   * EVERYTHING — and the server then requires `confirm: 'wipe-all'` to
   * proceed. The admin panel always passes the sentinel after the user
   * confirms via the dialog.
   */
  scope_type?: BindingScopeType;
  /** Only used when `scope_type='template'|'session'`. */
  scope_id?: number | null;
  /** Sentinel required for cross-scope wipes; the panel passes it. */
  confirm?: 'wipe-all';
}

export interface BulkApplyInput {
  provider_id: string;
  model_id: string;
  model_mode?: string;
  config?: Record<string, unknown>;
  scope_type?: BindingScopeType;
  scope_id?: number | null;
  enabled?: boolean;
  priority?: number;
  /**
   * When omitted, the server fans out to the entire catalog (every
   * non-`comingSoon` (pipeline, role) pair). Pass an explicit list to
   * target a subset.
   */
  targets?: Array<{ pipeline_name: string; binding_role: string }>;
}

/**
 * Bulk-clear bindings matching a scope filter. Returns the count of rows
 * removed. Throws on validation errors (e.g. missing `confirm` sentinel
 * when scope_type is omitted).
 */
export async function bulkClearBindings(opts: BulkClearOptions = {}): Promise<{ ok: boolean; removed: number }> {
  const r = await fetch('/api/admin/pipeline-bindings/bulk/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string; detail?: string };
    throw new Error(err.detail ?? err.error ?? `HTTP ${r.status}`);
  }
  return (await r.json()) as { ok: boolean; removed: number };
}

/**
 * Apply one provider+model+config to many catalog targets in a single
 * transaction. When `targets` is omitted, the server fans out to the
 * entire catalog.
 */
export async function bulkApplyBindings(input: BulkApplyInput): Promise<{ ok: boolean; applied: number; ids: number[] }> {
  const r = await fetch('/api/admin/pipeline-bindings/bulk/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string; details?: unknown };
    const detail = Array.isArray(err.details) ? err.details.join(', ') : (err.details as string | undefined);
    throw new Error(detail ?? err.error ?? `HTTP ${r.status}`);
  }
  return (await r.json()) as { ok: boolean; applied: number; ids: number[] };
}
