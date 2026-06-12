/**
 * PipelineProviderResolver — hierarchical lookup of provider+model+config
 * for a given pipeline+role.
 *
 * No pipeline code should ever instantiate a provider client directly.
 * Instead, every consumer calls `resolver.resolve(pipelineName, bindingRole, ctx)`
 * and receives a `ResolvedBinding` that includes provider credentials, model
 * id, and any per-binding config (temperature, max_tokens, …).
 *
 * Lookup order (first non-disabled match wins):
 *   1. scope_type='session',  scope_id=ctx.companySessionId or ctx.sessionId
 *   2. scope_type='template', scope_id=ctx.templateId
 *   3. scope_type='global',   scope_id=null
 *   4. Optional caller-supplied fallback default
 *
 * If all four miss, throws `PipelineBindingMissingError` — the caller is
 * expected to handle gracefully (typically by marking that stage as
 * `degraded` and letting candidates pass through unscored).
 */
import type {
  PipelineProviderBinding,
  PipelineProviderBindingsStore,
} from '@mcp/store/pipeline-provider-bindings-store.js';
import type { ProviderConfig, ProviderStore } from '@mcp/store/provider-store.js';

export interface ResolveContext {
  /** A coder/code-agent session id. */
  sessionId?: number;
  /** A company session id (multi-agent). */
  companySessionId?: number;
  /** Template id (resolved from the company session). */
  templateId?: number;
}

export interface ResolvedBinding {
  pipelineName: string;
  bindingRole: string;
  provider: ProviderConfig;
  modelId: string;
  modelMode: string;
  config: Record<string, unknown>;
  /** Which scope this came from — useful for telemetry / debugging. */
  resolvedFrom: 'session' | 'template' | 'global' | 'fallback';
  bindingId: number | null;
}

export interface FallbackDefault {
  /** Exact provider to use — preferred over `providerKind` when set and the
   *  provider is still enabled (avoids landing on a sibling of the same kind). */
  providerId?: string;
  providerKind: string;
  modelId: string;
  modelMode?: string;
  config?: Record<string, unknown>;
}

export class PipelineBindingMissingError extends Error {
  constructor(
    public pipelineName: string,
    public bindingRole: string,
    public attempts: Array<{ scope: string; reason: string }>,
  ) {
    super(
      `No binding found for ${pipelineName}/${bindingRole}. Attempts: ${
        attempts.map((a) => `${a.scope}:${a.reason}`).join(', ')
      }`,
    );
    this.name = 'PipelineBindingMissingError';
  }
}

export class PipelineProviderResolver {
  constructor(
    private bindingsStore: PipelineProviderBindingsStore,
    private providerStore: ProviderStore,
  ) {}

  /**
   * Resolve the active binding for a pipeline+role, given a context. The
   * optional `fallbackDefault` is consulted only if no DB row matches at
   * any scope — useful for the very first run before an admin sets the row.
   */
  async resolve(
    pipelineName: string,
    bindingRole: string,
    ctx: ResolveContext = {},
    fallbackDefault?: FallbackDefault,
  ): Promise<ResolvedBinding> {
    const attempts: Array<{ scope: string; reason: string }> = [];

    // 1. Session scope (company session has priority over coder session)
    const sessionScopeId = ctx.companySessionId ?? ctx.sessionId ?? null;
    if (sessionScopeId != null) {
      const row = this.bindingsStore.findActiveAtScope({
        pipelineName,
        bindingRole,
        scopeType: 'session',
        scopeId: sessionScopeId,
      });
      const resolved = await this.tryEnrich(row, pipelineName, bindingRole, 'session');
      if (resolved) return resolved;
      attempts.push({ scope: 'session', reason: row ? 'provider-missing' : 'no-row' });
    } else {
      attempts.push({ scope: 'session', reason: 'no-context' });
    }

    // 2. Template scope
    if (ctx.templateId != null) {
      const row = this.bindingsStore.findActiveAtScope({
        pipelineName,
        bindingRole,
        scopeType: 'template',
        scopeId: ctx.templateId,
      });
      const resolved = await this.tryEnrich(row, pipelineName, bindingRole, 'template');
      if (resolved) return resolved;
      attempts.push({ scope: 'template', reason: row ? 'provider-missing' : 'no-row' });
    } else {
      attempts.push({ scope: 'template', reason: 'no-context' });
    }

    // 3. Global scope
    {
      const row = this.bindingsStore.findActiveAtScope({
        pipelineName,
        bindingRole,
        scopeType: 'global',
        scopeId: null,
      });
      const resolved = await this.tryEnrich(row, pipelineName, bindingRole, 'global');
      if (resolved) return resolved;
      attempts.push({ scope: 'global', reason: row ? 'provider-missing' : 'no-row' });
    }

    // 4. Caller-supplied fallback default
    if (fallbackDefault) {
      const provider = this.findFallbackProvider(fallbackDefault);
      if (provider) {
        return {
          pipelineName,
          bindingRole,
          provider,
          modelId: fallbackDefault.modelId,
          modelMode: fallbackDefault.modelMode ?? '',
          config: fallbackDefault.config ?? {},
          resolvedFrom: 'fallback',
          bindingId: null,
        };
      }
      attempts.push({ scope: 'fallback', reason: 'no-provider-of-kind' });
    }

    throw new PipelineBindingMissingError(pipelineName, bindingRole, attempts);
  }

  /**
   * Like `resolve` but returns null on miss instead of throwing. Lets a
   * caller "best-effort" use a pipeline (e.g. skip the scorer if no
   * embedder is bound).
   */
  async resolveOrNull(
    pipelineName: string,
    bindingRole: string,
    ctx: ResolveContext = {},
    fallbackDefault?: FallbackDefault,
  ): Promise<ResolvedBinding | null> {
    try {
      return await this.resolve(pipelineName, bindingRole, ctx, fallbackDefault);
    } catch (e) {
      if (e instanceof PipelineBindingMissingError) return null;
      throw e;
    }
  }

  private async tryEnrich(
    row: PipelineProviderBinding | null,
    pipelineName: string,
    bindingRole: string,
    resolvedFrom: 'session' | 'template' | 'global',
  ): Promise<ResolvedBinding | null> {
    if (!row) return null;
    const provider = this.providerStore.getProvider(row.provider_id);
    if (!provider || !provider.enabled) return null;
    return {
      pipelineName,
      bindingRole,
      provider,
      modelId: row.model_id,
      modelMode: row.model_mode,
      config: row.config,
      resolvedFrom,
      bindingId: row.id,
    };
  }

  private findFallbackProvider(fallback: FallbackDefault): ProviderConfig | null {
    const candidates = this.providerStore.listProviders({ enabled: true });
    if (fallback.providerId) {
      const exact = candidates.find((p) => p.id === fallback.providerId);
      if (exact) return exact;
    }
    const match =
      candidates.find((p) => p.kind === fallback.providerKind && p.is_default) ??
      candidates.find((p) => p.kind === fallback.providerKind) ??
      null;
    return match;
  }
}
