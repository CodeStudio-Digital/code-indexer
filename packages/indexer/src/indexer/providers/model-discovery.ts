import type { CodeIndexDB } from '@mcp/store/db.js';
import type { DiscoveredModel, ProviderName } from '@mcp/shared/types.js';
import { listDefinitions } from '@mcp/services/providers/registry.js';
import { readModelPage, readProviderPage, type ModelPage } from './model-catalog-read.js';
import { catalogTerms } from '@mcp/shared/providers/catalog-match.js';
import { fetchDiscoveryModels } from './model-discovery-fetch.js';
import { catalogSelection, looksLikeModelName, readRequirements, type CatalogIntentRequest, type CatalogRequirements } from './catalog-intent.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { ModelCatalogIndex } from './model-catalog-index.js';

export interface ModelDiscoveryOptions {
  signal?: AbortSignal;
  /** Tool reads never mutate the shared cache. Admin/CLI callers retain it. */
  persistCache?: boolean;
  onFallback?: (provider: string, reason: string) => void;
}

function checkPage(offset: number, limit: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('Invalid model catalog page');
  }
}

function defaults(kind: string): DiscoveredModel[] {
  return (listDefinitions().find(d => d.kind === kind)?.defaultModels ?? []).map(id => ({
    id, provider: kind as ProviderName, name: id, capabilities: ['text'], cached_at: '',
  }));
}

export class ModelDiscovery {
  private readonly metadata: ModelCatalogIndex;
  constructor(private db: CodeIndexDB, private readonly catalogOwner?: (request: CatalogIntentRequest, signal?: AbortSignal) => Promise<ModelPage | null>) {
    this.metadata = new ModelCatalogIndex(db);
  }

  async searchIntent(request: CatalogIntentRequest, signal?: AbortSignal): Promise<ModelPage> {
    checkPage(request.offset, request.limit);
    if (typeof request.query !== 'string' || request.query.length > 256 || (request.provider !== undefined &&
      (typeof request.provider !== 'string' || !request.provider.trim() || request.provider.length > 256))) throw new Error('Invalid catalog intent');
    const checked = { ...request, requires: readRequirements(request.requires) };
    signal?.throwIfAborted();
    return await this.catalogOwner?.(checked, signal) ?? this.metadata.search(checked, signal);
  }

  providerPage(query: string | undefined, offset: number, limit: number) {
    checkPage(offset, limit);
    return readProviderPage(this.db, query, offset, limit);
  }

  /** A bounded projection for tool callers. The admin catalog is paged in SQL. */
  async discoverPage(provider: ProviderName | undefined, live: boolean, offset: number, limit: number,
    options: ModelDiscoveryOptions & { query?: string; match?: 'name' | 'intent'; requires?: CatalogRequirements } = {}): Promise<ModelPage> {
    checkPage(offset, limit);
    options.signal?.throwIfAborted();
    if (!live) {
      const { match } = options;
      const selection = catalogSelection(options.query ?? '', provider, options.requires, () => new ProviderStore(this.db.raw()).listProviderIdentities());
      if (selection.conflict) return { models: [], total: 0, offset };
      const query = selection.query || undefined, requires = selection.requires;
      provider = selection.provider as ProviderName | undefined;
      if (match === 'intent' || (!query && requires && Object.keys(requires).length)) {
        return this.searchIntent({ query: query ?? '', requires, provider, offset, limit }, options.signal);
      }
      if (query && !/\s/.test(query)) {
        const exact = readModelPage(this.db, provider, offset, limit, query, requires, true);
        if (exact.total || (requires && readModelPage(this.db, provider, 0, 1, query, undefined, true).total)) return exact;
      }
      const page = readModelPage(this.db, provider, offset, limit, query, requires);
      if (query && !page.total && match !== 'name' && !looksLikeModelName(query)) {
        // An exact name failing a requirement stays unavailable even if other models satisfy it.
        if (!requires || !Object.keys(requires).length || !readModelPage(this.db, provider, 0, 1, query).total) {
          return this.searchIntent({ query, requires, provider, offset, limit }, options.signal);
        }
      }
      // A search or configured profile must not fall back to an unconfigured public model.
      // On a fresh installation retain the legacy provider-only browse of registry defaults.
      if (page.total || options.query || (provider && this.db.raw().prepare('SELECT 1 FROM provider_configs LIMIT 1').get())) return page;
    }
    const discovered = await this.discoverModels(provider, live, { ...options, persistCache: false });
    const terms = options.query && catalogTerms(options.query);
    const all = terms ? discovered.filter(m => terms.length && terms.every(t => (m.id + ' ' + m.name).toLowerCase().includes(t))) : discovered;
    options.signal?.throwIfAborted();
    const models = all.slice(offset, offset + limit);
    return { models, total: all.length, offset,
      ...(offset + models.length < all.length ? { next_offset: offset + models.length } : {}) };
  }

  /** Default listing is local only. An explicit live refresh has one 10s budget,
   * including body transfer, and at most four concurrent provider reads. */
  async discoverModels(provider?: ProviderName, live = false, options: ModelDiscoveryOptions = {}): Promise<DiscoveredModel[]> {
    options.signal?.throwIfAborted();
    if (!live) {
      const page = readModelPage(this.db, provider, 0, -1);
      if (page.total) return page.models;
    }
    const definitions = listDefinitions();
    const kinds = provider ? [provider] : definitions.map(d => d.kind);
    const results: DiscoveredModel[][] = new Array(kinds.length);
    const deadline = new AbortController();
    const timer = live ? setTimeout(() => deadline.abort(new DOMException('Model discovery deadline exceeded', 'TimeoutError')), 10_000) : undefined;
    timer?.unref();
    const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
    let next = 0;
    const read = async () => {
      while (next < kinds.length) {
        const index = next++, kind = kinds[index]; signal.throwIfAborted();
        const cached = this.db.getCachedModels(kind as ProviderName);
        if (!live) { results[index] = cached ?? defaults(kind); continue; }
        const envVar = definitions.find(d => d.kind === kind)?.envVars[0];
        const apiKey = envVar ? process.env[envVar] : undefined;
        if (!apiKey) {
          options.onFallback?.(kind, 'No environment credential for live listing; showing local catalog. Use the provider settings to refresh OAuth or custom providers.');
          results[index] = this.localFallback(kind, cached); continue;
        }
        try {
          const models = await fetchDiscoveryModels(kind as ProviderName, apiKey, signal);
          signal.throwIfAborted();
          if (options.persistCache !== false) this.db.setCachedModels(kind as ProviderName, models);
          results[index] = models;
        } catch {
          // Cancellation is never converted into defaults or followed by a write.
          signal.throwIfAborted();
          options.onFallback?.(kind, 'Live listing failed; showing local catalog.');
          results[index] = this.localFallback(kind, cached);
        }
      }
    };
    try {
      // Wait for every in-flight fetch to settle before releasing the caller.
      const outcomes = await Promise.allSettled(Array.from({ length: Math.min(4, kinds.length) }, read));
      signal.throwIfAborted();
      for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
      return results.flat();
    } finally { if (timer) clearTimeout(timer); }
  }

  private localFallback(kind: string, cached: DiscoveredModel[] | null): DiscoveredModel[] {
    const page = readModelPage(this.db, kind, 0, -1);
    return page.total ? page.models : cached ?? defaults(kind);
  }
}
