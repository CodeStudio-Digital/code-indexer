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
   *
   * Returns the single best binding (`resolveChain()[0]`). Callers that want
   * runtime failover across every enabled binding use `resolveChain` instead.
   */
  async resolve(
    pipelineName: string,
    bindingRole: string,
    ctx: ResolveContext = {},
    fallbackDefault?: FallbackDefault,
  ): Promise<ResolvedBinding> {
    const { chain, attempts } = await this.buildChain(pipelineName, bindingRole, ctx, fallbackDefault);
    if (chain.length === 0) {
      throw new PipelineBindingMissingError(pipelineName, bindingRole, attempts);
    }
    return chain[0];
  }

  /**
   * Resolve the ORDERED failover chain for a pipeline+role: every enabled
   * binding at the first scope that yields at least one usable binding, in
   * `priority DESC, id ASC` order, with the optional `fallbackDefault`
   * appended as the last link (unless a chain binding already uses that
   * provider).
   *
   * The scope hierarchy (session → template → global) is unchanged — a
   * session/template override is an intentional choice, so we never fail
   * over ACROSS scopes. Failover happens WITHIN the winning scope's binding
   * set plus the appended general default. Returns `[]` when nothing is
   * bound and no fallback resolves (the caller decides whether that's fatal).
   */
  async resolveChain(
    pipelineName: string,
    bindingRole: string,
    ctx: ResolveContext = {},
    fallbackDefault?: FallbackDefault,
  ): Promise<ResolvedBinding[]> {
    const { chain } = await this.buildChain(pipelineName, bindingRole, ctx, fallbackDefault);
    return chain;
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

  /**
   * Core walk shared by `resolve` and `resolveChain`. Returns the winning
   * scope's enriched binding list (best-first) plus the per-scope attempts
   * trail for diagnostics. Unlike the old single-row lookup, this enriches
   * EVERY enabled row at a scope, so a disabled top-priority provider no
   * longer hides a healthy sibling at the same scope.
   */
  private async buildChain(
    pipelineName: string,
    bindingRole: string,
    ctx: ResolveContext,
    fallbackDefault?: FallbackDefault,
  ): Promise<{ chain: ResolvedBinding[]; attempts: Array<{ scope: string; reason: string }> }> {
    const attempts: Array<{ scope: string; reason: string }> = [];

    const enrichScope = async (
      scope: 'session' | 'template' | 'global',
      scopeId: number | null,
    ): Promise<ResolvedBinding[]> => {
      const rows = this.bindingsStore.findAllActiveAtScope({
        pipelineName,
        bindingRole,
        scopeType: scope,
        scopeId,
      });
      const enriched: ResolvedBinding[] = [];
      for (const row of rows) {
        const r = await this.tryEnrich(row, pipelineName, bindingRole, scope);
        if (r) enriched.push(r);
      }
      if (rows.length > 0 && enriched.length === 0) {
        attempts.push({ scope, reason: 'provider-missing' });
      } else if (rows.length === 0) {
        attempts.push({ scope, reason: 'no-row' });
      }
      return enriched;
    };

    // Append the general default as the last failover link (distinct provider).
    const withFallback = (chain: ResolvedBinding[]): ResolvedBinding[] => {
      if (!fallbackDefault) return chain;
      const link = this.makeFallbackLink(pipelineName, bindingRole, fallbackDefault);
      if (link && !chain.some((b) => b.provider.id === link.provider.id)) chain.push(link);
      return chain;
    };

    // 1. Session scope (company session has priority over coder session)
    const sessionScopeId = ctx.companySessionId ?? ctx.sessionId ?? null;
    if (sessionScopeId != null) {
      const chain = await enrichScope('session', sessionScopeId);
      if (chain.length) return { chain: withFallback(chain), attempts };
    } else {
      attempts.push({ scope: 'session', reason: 'no-context' });
    }

    // 2. Template scope
    if (ctx.templateId != null) {
      const chain = await enrichScope('template', ctx.templateId);
      if (chain.length) return { chain: withFallback(chain), attempts };
    } else {
      attempts.push({ scope: 'template', reason: 'no-context' });
    }

    // 3. Global scope
    {
      const chain = await enrichScope('global', null);
      if (chain.length) return { chain: withFallback(chain), attempts };
    }

    // 4. Caller-supplied fallback default only.
    if (fallbackDefault) {
      const link = this.makeFallbackLink(pipelineName, bindingRole, fallbackDefault);
      if (link) return { chain: [link], attempts };
      attempts.push({ scope: 'fallback', reason: 'no-provider-of-kind' });
    }

    return { chain: [], attempts };
  }

  /**
   * Build a binding from the fallback default ONLY, ignoring binding rows.
   * A bound provider that exists but FAILS at runtime never falls back via
   * `resolve` (rows win); callers that want a one-shot retry on the general
   * default (memory distill) use this to get the fallback binding directly.
   */
  resolveFallbackOnly(
    pipelineName: string,
    bindingRole: string,
    fallbackDefault: FallbackDefault,
  ): ResolvedBinding | null {
    return this.makeFallbackLink(pipelineName, bindingRole, fallbackDefault);
  }

  /** Build a `resolvedFrom:'fallback'` binding from the general default, or null. */
  private makeFallbackLink(
    pipelineName: string,
    bindingRole: string,
    fallbackDefault: FallbackDefault,
  ): ResolvedBinding | null {
    const provider = this.findFallbackProvider(fallbackDefault);
    if (!provider) return null;
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
