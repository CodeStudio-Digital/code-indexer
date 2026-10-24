import type { CodeIndexDB } from '@mcp/store/db.js';
import type { DiscoveredModel, ProviderName } from '@mcp/shared/types.js';
import { listDefinitions } from '@mcp/services/providers/registry.js';
import { readModelPage, type ModelPage } from './model-catalog-read.js';
import { fetchDiscoveryModels } from './model-discovery-fetch.js';

export interface ModelDiscoveryOptions {
  signal?: AbortSignal;
  /** Tool reads never mutate the shared cache. Admin/CLI callers retain it. */
  persistCache?: boolean;
  onFallback?: (provider: string, reason: string) => void;
}

function defaults(kind: string): DiscoveredModel[] {
  return (listDefinitions().find(d => d.kind === kind)?.defaultModels ?? []).map(id => ({
    id, provider: kind as ProviderName, name: id, capabilities: ['text'], cached_at: '',
  }));
}

export class ModelDiscovery {
  constructor(private db: CodeIndexDB) {}

  /** A bounded projection for tool callers. The admin catalog is paged in SQL. */
  async discoverPage(provider: ProviderName | undefined, live: boolean, offset: number, limit: number,
    options: ModelDiscoveryOptions = {}): Promise<ModelPage> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Invalid model catalog page');
    }
    options.signal?.throwIfAborted();
    if (!live) {
      const page = readModelPage(this.db, provider, offset, limit);
      if (page.total) return page;
    }
    const all = await this.discoverModels(provider, live, { ...options, persistCache: false });
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
