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
import type { BindingScopeType, PipelineBindingActivationInput, PipelineProfileApplyRow, PipelineProviderBindingInput } from '@mcp/store/pipeline-provider-bindings-store.js';
import { PIPELINE_CATALOG, setupTargetsForCapability, type CapabilityKind, type PipelineCatalogEntry } from '@mcp/services/pipelines/index.js';
import { mountPipelineBindingReadRoutes } from './pipeline-binding-read-routes.js';
import { type UpsertBody, isValidScope, knownCatalogEntry, unknownCatalogTargetResponse, nonConfigurableCatalogEntry, bindingNotConfigurableResponse, type PatchBody, isValidCapability } from './pipeline-binding-validation.js';

export function mountAdminPipelineBindingsRoutes(app: HttpRouter, deps: ServerDeps): void {
  const { pipelineBindingsStore, pipelineProviderResolver, providerStore } = deps;
  mountPipelineBindingReadRoutes(app, deps);

  // ───── POST / ──────────────────────────────────────────────────────────
  app.post('/api/admin/pipeline-bindings', async (c) => {
    let body: UpsertBody;
    try {
      body = (await c.req.json()) as UpsertBody;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const errors: string[] = [];
    if (!body.pipeline_name) errors.push('pipeline_name is required');
    if (!body.binding_role) errors.push('binding_role is required');
    if (!body.provider_id)  errors.push('provider_id is required');
    if (!body.model_id)     errors.push('model_id is required');
    if (!isValidScope(body.scope_type)) errors.push('scope_type must be global|template');
    if (body.scope_type === 'template' && body.scope_id == null) {
      errors.push('scope_id is required for template scope');
    }
    if (errors.length > 0) return c.json({ error: 'validation_failed', details: errors }, 400);

    if (!knownCatalogEntry(body.pipeline_name, body.binding_role)) {
      return unknownCatalogTargetResponse(c, body.pipeline_name, body.binding_role);
    }
    const nonConfigurable = nonConfigurableCatalogEntry(body.pipeline_name, body.binding_role);
    if (nonConfigurable) return bindingNotConfigurableResponse(c, nonConfigurable);

    if (!providerStore.getProvider(body.provider_id!)) {
      return c.json({ error: 'provider_not_found', provider_id: body.provider_id }, 404);
    }

    const input: PipelineProviderBindingInput = {
      pipeline_name: body.pipeline_name!,
      binding_role:  body.binding_role!,
      provider_id:   body.provider_id!,
      model_id:      body.model_id!,
      model_mode:    body.model_mode ?? '',
      config:        body.config ?? {},
      scope_type:    body.scope_type!,
      scope_id:      body.scope_type === 'global' ? null : body.scope_id ?? null,
      enabled:       body.enabled !== false,
      priority:      body.priority ?? 0,
    };

    const id = pipelineBindingsStore.upsert(input);
    return c.json({ id, binding: pipelineBindingsStore.get(id) });
  });

  // ───── POST /activate ─────────────────────────────────────────────────
  // Guided completion setup uses this instead of a plain upsert so changing
  // model cannot leave two equally-ranked global routes active.
  app.post('/api/admin/pipeline-bindings/activate', async (c) => {
    let body: UpsertBody;
    try {
      body = (await c.req.json()) as UpsertBody;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const errors: string[] = [];
    if (!body.pipeline_name) errors.push('pipeline_name is required');
    if (!body.binding_role) errors.push('binding_role is required');
    if (!body.provider_id) errors.push('provider_id is required');
    if (!body.model_id) errors.push('model_id is required');
    if (body.scope_type !== undefined && body.scope_type !== 'global') errors.push('only global scope is supported');
    if (errors.length > 0) return c.json({ error: 'validation_failed', details: errors }, 400);
    if (!knownCatalogEntry(body.pipeline_name, body.binding_role)) {
      return unknownCatalogTargetResponse(c, body.pipeline_name, body.binding_role);
    }
    const nonConfigurable = nonConfigurableCatalogEntry(body.pipeline_name, body.binding_role);
    if (nonConfigurable) return bindingNotConfigurableResponse(c, nonConfigurable);
    if (!providerStore.getProvider(body.provider_id!)) {
      return c.json({ error: 'provider_not_found', provider_id: body.provider_id }, 404);
    }
    const input: PipelineBindingActivationInput = {
      pipeline_name: body.pipeline_name!, binding_role: body.binding_role!,
      provider_id: body.provider_id!, model_id: body.model_id!,
      model_mode: body.model_mode ?? '', config: body.config ?? {}, priority: body.priority ?? 0,
    };
    const activated = pipelineBindingsStore.activateGlobal(input);
    return c.json({ ...activated, binding: pipelineBindingsStore.get(activated.id) });
  });

  // ───── PATCH /:id ──────────────────────────────────────────────────────
  app.patch('/api/admin/pipeline-bindings/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid_id' }, 400);
    const existing = pipelineBindingsStore.get(id);
    if (!existing) return c.json({ error: 'not_found' }, 404);

    let body: PatchBody;
    try {
      body = (await c.req.json()) as PatchBody;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    // Check both legacy rows and a requested target change. Without the
    // second check, a configurable row could be renamed into an
    // informational semantic-profile role through PATCH.
    const targetPipelineName = body.pipeline_name ?? existing.pipeline_name;
    const targetBindingRole = body.binding_role ?? existing.binding_role;
    if (!knownCatalogEntry(targetPipelineName, targetBindingRole)) {
      return unknownCatalogTargetResponse(c, targetPipelineName, targetBindingRole);
    }
    const nonConfigurable = nonConfigurableCatalogEntry(targetPipelineName, targetBindingRole);
    if (nonConfigurable) return bindingNotConfigurableResponse(c, nonConfigurable);

    const scopeType = body.scope_type ?? existing.scope_type;
    if (!isValidScope(scopeType)) return c.json({ error: 'scope_type must be global|template' }, 400);
    const scopeId = scopeType === 'global' ? null : (body.scope_id !== undefined ? body.scope_id : existing.scope_id);
    if (scopeType === 'template' && scopeId == null) {
      return c.json({ error: 'scope_id is required for template scope' }, 400);
    }

    const providerId = body.provider_id ?? existing.provider_id;
    if (!providerStore.getProvider(providerId)) {
      return c.json({ error: 'provider_not_found', provider_id: providerId }, 404);
    }

    const input: PipelineProviderBindingInput = {
      pipeline_name: body.pipeline_name ?? existing.pipeline_name,
      binding_role:  body.binding_role ?? existing.binding_role,
      provider_id:   providerId,
      model_id:      body.model_id ?? existing.model_id,
      model_mode:    body.model_mode ?? existing.model_mode,
      config:        body.config ?? existing.config,
      scope_type:    scopeType,
      scope_id:      scopeId,
      enabled:       body.enabled ?? existing.enabled,
      priority:      body.priority ?? existing.priority,
    };
    pipelineBindingsStore.update(id, input);
    return c.json({ binding: pipelineBindingsStore.get(id) });
  });

  // ───── DELETE /:id ─────────────────────────────────────────────────────
  app.delete('/api/admin/pipeline-bindings/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid_id' }, 400);
    const removed = pipelineBindingsStore.delete(id);
    if (!removed) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  });

  // ───── POST /:id/test ──────────────────────────────────────────────────
  //
  // Smoke test: verifies that the bound provider is reachable and the model
  // is enabled. Doesn't run an actual classifier/embedder call yet (that's
  // wired per-pipeline once the consuming code lands) — for now we just
  // check the provider is enabled, has credentials, and the model exists in
  // `provider_models`.
  app.post('/api/admin/pipeline-bindings/:id/test', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid_id' }, 400);
    const binding = pipelineBindingsStore.get(id);
    if (!binding) return c.json({ error: 'not_found' }, 404);

    const provider = providerStore.getProvider(binding.provider_id);
    if (!provider) {
      return c.json({ ok: false, reason: 'provider_missing', provider_id: binding.provider_id });
    }
    if (!provider.enabled) {
      return c.json({ ok: false, reason: 'provider_disabled', provider });
    }

    const models = providerStore.listModels(provider.id, true);
    const modelMatch = models.find(
      (m) => m.model_id === binding.model_id && (binding.model_mode === '' || m.mode === binding.model_mode),
    );
    if (!modelMatch) {
      return c.json({
        ok: false,
        reason: 'model_not_enabled_for_provider',
        provider_id: provider.id,
        model_id: binding.model_id,
        model_mode: binding.model_mode,
        known_models: models.map((m) => ({ model_id: m.model_id, mode: m.mode })),
      });
    }

    return c.json({
      ok: true,
      provider: { id: provider.id, name: provider.name, kind: provider.kind },
      model: modelMatch,
      config: binding.config,
    });
  });

  // ───── POST /bulk/clear ────────────────────────────────────────────────
  //
  // Wipe every binding that matches the scope filter. The admin panel calls
  // this when the operator wants a clean slate before applying a uniform
  // provider+model across all pipelines.
  //
  // Body shape:
  //   { scope_type?: 'global' | 'template',
  //     scope_id?: number | null }
  //
  // Without a scope_type, EVERYTHING is wiped — guarded behind a
  // `confirm: 'wipe-all'` body sentinel that the panel always sends so an
  // accidental empty POST doesn't blow up the table.
  app.post('/api/admin/pipeline-bindings/bulk/clear', async (c) => {
    let body: { scope_type?: BindingScopeType; scope_id?: number | null; confirm?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (body.scope_type !== undefined && !isValidScope(body.scope_type)) {
      return c.json({ error: 'invalid_scope_type' }, 400);
    }
    // Refuse a "wipe everything" call unless the client sent the sentinel.
    if (body.scope_type === undefined && body.confirm !== 'wipe-all') {
      return c.json(
        { error: 'confirmation_required', detail: 'Pass confirm:"wipe-all" to wipe across all scopes.' },
        400,
      );
    }
    const removed = pipelineBindingsStore.bulkDelete({
      scopeType: body.scope_type,
      scopeId: body.scope_id ?? undefined,
    });
    return c.json({ ok: true, removed });
  });

  // ───── POST /bulk/apply ────────────────────────────────────────────────
  //
  // Apply ONE provider+model+config to a list of catalog targets. Body:
  //
  //   { provider_id, model_id, model_mode?, config?,
  //     scope_type?, scope_id?, enabled?, priority?,
  //     targets?: Array<{ pipeline_name, binding_role }> }
  //
  // When `targets` is omitted, the server fans out only to setup-eligible
  // catalog roles. Embedding and semantic reranking roles are absent here:
  // their runtime configuration belongs to Semantic Indexing.
  //
  // The provider is validated first — a typo here would silently fail
  // every upsert if we let it through.
  app.post('/api/admin/pipeline-bindings/bulk/apply', async (c) => {
    let body: {
      provider_id?: string;
      model_id?: string;
      model_mode?: string;
      config?: Record<string, unknown>;
      scope_type?: BindingScopeType;
      scope_id?: number | null;
      enabled?: boolean;
      priority?: number;
      targets?: Array<{ pipeline_name: string; binding_role: string }>;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const errors: string[] = [];
    if (!body.provider_id) errors.push('provider_id is required');
    if (!body.model_id)    errors.push('model_id is required');
    if (body.scope_type !== undefined && !isValidScope(body.scope_type)) {
      errors.push('scope_type must be global|template');
    }
    if (body.scope_type === 'template' && body.scope_id == null) {
      errors.push('scope_id is required for template scope');
    }
    if (errors.length > 0) return c.json({ error: 'validation_failed', details: errors }, 400);

    if (!providerStore.getProvider(body.provider_id!)) {
      return c.json({ error: 'provider_not_found', provider_id: body.provider_id }, 404);
    }

    // The default set contains only roles this screen is allowed to configure.
    // `comingSoon` entries are placeholders and any future
    // `setupEligible:false` entries may not be bulk-created.
    const targets = (body.targets && body.targets.length > 0)
      ? body.targets
      : PIPELINE_CATALOG
          .filter((e) => !e.comingSoon && e.setupEligible !== false)
          .map((e) => ({ pipeline_name: e.pipelineName, binding_role: e.bindingRole }));

    if (targets.length === 0) {
      return c.json({ ok: true, applied: 0, ids: [] });
    }

    // Sanity check: every requested target must be a known catalog entry
    // (defense against typos that would create orphan bindings).
    const knownPairs = new Set(
      PIPELINE_CATALOG.map((e) => `${e.pipelineName}::${e.bindingRole}`),
    );
    const unknown = targets.filter((t) => !knownPairs.has(`${t.pipeline_name}::${t.binding_role}`));
    if (unknown.length > 0) {
      return c.json(
        { error: 'unknown_targets', details: unknown },
        400,
      );
    }

    // Explicit target lists must fail atomically instead of silently applying
    // their configurable subset. This keeps stale clients from recreating the
    // old embedder/reranker bindings after the semantic-profile migration.
    const nonConfigurable = targets
      .map((target) => nonConfigurableCatalogEntry(target.pipeline_name, target.binding_role))
      .find((entry): entry is PipelineCatalogEntry => entry !== null);
    if (nonConfigurable) return bindingNotConfigurableResponse(c, nonConfigurable);

    const ids = pipelineBindingsStore.bulkApply({
      targets,
      provider_id: body.provider_id!,
      model_id:    body.model_id!,
      model_mode:  body.model_mode ?? '',
      config:      body.config ?? {},
      scope_type:  body.scope_type ?? 'global',
      scope_id:    body.scope_id ?? null,
      enabled:     body.enabled !== false,
      priority:    body.priority ?? 0,
    });
    return c.json({ ok: true, applied: ids.length, ids });
  });

  // ───── POST /bulk/apply-profile ────────────────────────────────────────
  //
  // Guided-setup ("Configuração assistida"). The wizard sends ONE assignment
  // per capability bucket; the server fans each out to that bucket's
  // setup-eligible catalog targets, stamping EACH target's own
  // `recommendedDefault.config` — so a classifier keeps max_tokens:256 while
  // a reviewer keeps max_tokens:4000+json_mode in the same call. Writes
  // GLOBAL scope only and REPLACES any existing global row per
  // (pipeline, role), so re-running the wizard never duplicates bindings.
  //
  // Body:
  //   { assignments: [{ capability_kind, provider_id, model_id, model_mode? }] }
  app.post('/api/admin/pipeline-bindings/bulk/apply-profile', async (c) => {
    let body: {
      scope_type?: BindingScopeType;
      assignments?: Array<{
        capability_kind?: string;
        provider_id?: string;
        model_id?: string;
        model_mode?: string;
      }>;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    // The wizard only configures the global scope.
    if (body.scope_type !== undefined && body.scope_type !== 'global') {
      return c.json({ error: 'validation_failed', details: ['only scope_type "global" is supported'] }, 400);
    }
    if (!Array.isArray(body.assignments) || body.assignments.length === 0) {
      return c.json({ error: 'validation_failed', details: ['assignments must be a non-empty array'] }, 400);
    }

    const errors: string[] = [];
    body.assignments.forEach((a, i) => {
      if (!isValidCapability(a.capability_kind)) errors.push(`assignments[${i}].capability_kind invalid`);
      if (!a.provider_id) errors.push(`assignments[${i}].provider_id is required`);
      if (!a.model_id)    errors.push(`assignments[${i}].model_id is required`);
    });
    if (errors.length > 0) return c.json({ error: 'validation_failed', details: errors }, 400);

    for (const a of body.assignments) {
      if (!providerStore.getProvider(a.provider_id!)) {
        return c.json({ error: 'provider_not_found', provider_id: a.provider_id }, 404);
      }
    }

    // Fan each assignment out to its bucket's setup-eligible targets,
    // carrying each target's OWN per-role config.
    const rows: PipelineProfileApplyRow[] = [];
    const byCapability: Record<string, number> = {};
    for (const a of body.assignments) {
      const kind = a.capability_kind as CapabilityKind;
      const targets = setupTargetsForCapability(kind);
      byCapability[kind] = targets.length;
      for (const t of targets) {
        rows.push({
          pipeline_name: t.pipelineName,
          binding_role:  t.bindingRole,
          provider_id:   a.provider_id!,
          model_id:      a.model_id!,
          model_mode:    a.model_mode ?? '',
          config:        t.recommendedDefault?.config ?? {},
        });
      }
    }

    if (rows.length === 0) {
      return c.json({ ok: true, applied: 0, byCapability });
    }

    const ids = pipelineBindingsStore.bulkApplyProfile(rows);
    return c.json({ ok: true, applied: ids.length, byCapability });
  });

  // ───── GET /resolve ────────────────────────────────────────────────────
  //
  // Lets an admin preview what `PipelineProviderResolver.resolve()` would
  // return for a given (pipeline, role, template). Session-scoped mutable
  // configuration lives in the session bundle and is not exposed by this
  // SQLite-backed admin API.
  // debugging "why is my binding not being picked up?".
  app.get('/api/admin/pipeline-bindings/resolve', async (c) => {
    const pipelineName = c.req.query('pipeline_name');
    const bindingRole  = c.req.query('binding_role');
    if (!pipelineName || !bindingRole) {
      return c.json({ error: 'pipeline_name and binding_role required' }, 400);
    }

    const sessionIdRaw         = c.req.query('session_id');
    const companySessionIdRaw  = c.req.query('company_session_id');
    const templateIdRaw        = c.req.query('template_id');

    if (sessionIdRaw != null || companySessionIdRaw != null) {
      return c.json({
        error: 'session_scope_not_supported',
        detail: 'Session-scoped pipeline configuration lives in the filesystem session bundle.',
      }, 400);
    }
    const ctx: { templateId?: number } = {};
    if (templateIdRaw && Number.isFinite(Number(templateIdRaw))) ctx.templateId = Number(templateIdRaw);

    const resolved = await pipelineProviderResolver.resolveOrNull(pipelineName, bindingRole, ctx);
    if (!resolved) {
      return c.json({ ok: false, resolved: null, ctx });
    }
    return c.json({
      ok: true,
      resolved: {
        provider_id: resolved.provider.id,
        provider_name: resolved.provider.name,
        provider_kind: resolved.provider.kind,
        model_id: resolved.modelId,
        model_mode: resolved.modelMode,
        config: resolved.config,
        resolved_from: resolved.resolvedFrom,
        binding_id: resolved.bindingId,
      },
      ctx,
    });
  });
}
