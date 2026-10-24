import type { BindingScopeType } from '@mcp/store/pipeline-provider-bindings-store.js';
import { PIPELINE_CATALOG, type CapabilityKind, type PipelineCatalogEntry } from '@mcp/services/pipelines/index.js';
/**
 * Admin routes for the pipeline_provider_bindings table (migration 080).
 *
 * Provider+model+config selection per pipeline is admin-managed, NOT
 * hard-coded in pipeline code. Every pipeline stage that calls an LLM
 * resolves its binding via `PipelineProviderResolver`; this router lets
 * the admin manage those bindings without a redeploy.
 *
 *   GET    /api/admin/pipeline-bindings              → list (with catalog hints)
 *   GET    /api/admin/pipeline-bindings/catalog      → static catalog only
 *   POST   /api/admin/pipeline-bindings              → upsert (returns id)
 *   POST   /api/admin/pipeline-bindings/activate     → sole active global binding
 *   PATCH  /api/admin/pipeline-bindings/:id          → toggle enabled / update priority
 *   DELETE /api/admin/pipeline-bindings/:id          → remove
 *   POST   /api/admin/pipeline-bindings/:id/test     → smoke test the binding
 *   GET    /api/admin/pipeline-bindings/resolve      → preview resolution for a context
 *
 *   POST   /api/admin/pipeline-bindings/bulk/clear   → wipe matching bindings
 *   POST   /api/admin/pipeline-bindings/bulk/apply   → apply one provider+model to many targets
 */
import type { Context } from 'hono';

export interface UpsertBody {
  pipeline_name?: string;
  binding_role?: string;
  provider_id?: string;
  model_id?: string;
  model_mode?: string;
  config?: Record<string, unknown>;
  scope_type?: BindingScopeType;
  scope_id?: number | null;
  enabled?: boolean;
  priority?: number;
}

export interface PatchBody extends Partial<UpsertBody> {}

const VALID_SCOPES: BindingScopeType[] = ['global', 'template'];

export function isValidScope(s: unknown): s is BindingScopeType {
  return typeof s === 'string' && VALID_SCOPES.includes(s as BindingScopeType);
}

const VALID_CAPABILITIES: CapabilityKind[] = [
  'text_llm', 'embeddings', 'reranking', 'vision', 'voice', 'autocomplete', 'image_gen',
];

export function isValidCapability(s: unknown): s is CapabilityKind {
  return typeof s === 'string' && VALID_CAPABILITIES.includes(s as CapabilityKind);
}

export function nonConfigurableCatalogEntry(
  pipelineName: string | undefined,
  bindingRole: string | undefined,
): PipelineCatalogEntry | null {
  if (!pipelineName || !bindingRole) return null;
  return PIPELINE_CATALOG.find(
    (entry) => entry.pipelineName === pipelineName
      && entry.bindingRole === bindingRole
      && entry.setupEligible === false,
  ) ?? null;
}

export function knownCatalogEntry(
  pipelineName: string | undefined,
  bindingRole: string | undefined,
): PipelineCatalogEntry | null {
  if (!pipelineName || !bindingRole) return null;
  return PIPELINE_CATALOG.find(
    (entry) => entry.pipelineName === pipelineName && entry.bindingRole === bindingRole,
  ) ?? null;
}

export function unknownCatalogTargetResponse(
  c: Context,
  pipelineName: string | undefined,
  bindingRole: string | undefined,
) {
  return c.json({
    error: 'unknown_target',
    details: [{ pipeline_name: pipelineName, binding_role: bindingRole }],
  }, 400);
}

export function bindingNotConfigurableResponse(
  c: Context,
  entry: PipelineCatalogEntry,
) {
  return c.json({
    error: 'binding_not_configurable',
    details: [entry.description],
    configure_in: 'semantic_indexing',
  }, 409);
}
