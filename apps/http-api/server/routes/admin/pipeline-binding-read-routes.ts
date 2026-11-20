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
import type { HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../../deps.js';
import { PIPELINE_CATALOG, groupCatalogByPipeline } from '@mcp/services/pipelines/index.js';
import type { BindingScopeType } from '@mcp/store/pipeline-provider-bindings-store.js';
import { isValidScope } from './pipeline-binding-validation.js';

export function mountPipelineBindingReadRoutes(app: HttpRouter, deps: ServerDeps): void {
const { pipelineBindingsStore, providerStore } = deps;


  // ───── GET /catalog ────────────────────────────────────────────────────
  app.get('/api/admin/pipeline-bindings/catalog', (c) => {
    const grouped = Array.from(groupCatalogByPipeline().entries()).map(
      ([pipelineName, roles]) => ({
        pipeline_name: pipelineName,
        roles,
      }),
    );
    return c.json({ catalog: PIPELINE_CATALOG, grouped });
  });

  // ───── GET / ───────────────────────────────────────────────────────────
  app.get('/api/admin/pipeline-bindings', (c) => {
    const pipelineName = c.req.query('pipeline_name') ?? undefined;
    const scopeTypeRaw = c.req.query('scope_type');
    const scopeIdRaw = c.req.query('scope_id');
    const enabledOnlyRaw = c.req.query('enabled_only');

    const opts: {
      pipelineName?: string;
      scopeType?: BindingScopeType;
      scopeId?: number;
      enabledOnly?: boolean;
    } = {};
    if (pipelineName) opts.pipelineName = pipelineName;
    if (scopeTypeRaw && !isValidScope(scopeTypeRaw)) {
      return c.json({ error: 'scope_type must be global|template' }, 400);
    }
    if (scopeTypeRaw) opts.scopeType = scopeTypeRaw as BindingScopeType;
    if (scopeIdRaw && Number.isFinite(Number(scopeIdRaw))) opts.scopeId = Number(scopeIdRaw);
    if (enabledOnlyRaw === 'true' || enabledOnlyRaw === '1') opts.enabledOnly = true;

    const rows = pipelineBindingsStore.list(opts);

    // Enrich with provider name + catalog hint for the panel UI.
    const enriched = rows.map((r) => {
      const provider = providerStore.getProvider(r.provider_id);
      const catalog = PIPELINE_CATALOG.find(
        (e) => e.pipelineName === r.pipeline_name && e.bindingRole === r.binding_role,
      );
      return {
        ...r,
        provider_name: provider?.name ?? null,
        provider_kind: provider?.kind ?? null,
        provider_enabled: provider?.enabled ?? false,
        catalog_description: catalog?.description ?? null,
      };
    });

    return c.json({ bindings: enriched, catalog: PIPELINE_CATALOG });
  });
}
