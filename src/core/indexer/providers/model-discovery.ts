import type { CodeIndexDB } from '../../../store/db.js';
import type { DiscoveredModel, ProviderName } from '../../../types.js';
import { ProviderStore } from '../../../store/provider-store.js';
import { loadConfig } from '../../../utils/config.js';
import { listDefinitions } from '../../providers/registry.js';

/**
 * Hardcoded fallback models are now pulled from the provider registry:
 * each definition declares its `defaultModels`. When live discovery or
 * the provider_models DB table is empty we fall back to those.
 */
function getHardcodedModels(kind: string): DiscoveredModel[] {
  const def = listDefinitions().find((d) => d.kind === kind);
  if (!def) return [];
  return def.defaultModels.map((id) => ({
    id,
    provider: kind as ProviderName,
    name: id,
    capabilities: ['text'],
    cached_at: '',
  }));
}

function getApiKeyEnv(kind: string): string | undefined {
  const def = listDefinitions().find((d) => d.kind === kind);
  return def?.envVars[0];
}

export class ModelDiscovery {
  private providerStore: ProviderStore | null = null;

  constructor(private db: CodeIndexDB) {
    // Reuse the same ProviderStore the admin UI + coder factory talk to,
    // so the indexer's model list is always the same one the dashboard
    // shows. Opened lazily so tests without a DB still work.
    try {
      const cfg = loadConfig();
      this.providerStore = new ProviderStore(cfg.dbPath);
    } catch {
      this.providerStore = null;
    }
  }

  /**
   * List models available for the indexer. SINGLE SOURCE OF TRUTH is the
   * `provider_models` table (what the admin UI writes). We only fall back
   * to the legacy live-fetch / hardcoded path when that table is empty,
   * so brand-new installations can still surface something. When `live`
   * is true we force a fresh refresh by bypassing the DB.
   */
  async discoverModels(provider?: ProviderName, live: boolean = false): Promise<DiscoveredModel[]> {
    // 1. Preferred path — read provider_models directly. This covers
    //    every kind (anthropic/openai/copilot/chatgpt/gemini/zai/...)
    //    and the list is exactly what the admin card shows.
    if (!live && this.providerStore) {
      const fromStore = this.readFromProviderModels(provider);
      if (fromStore.length > 0) return fromStore;
    }

    // 2. Legacy fallback — cache / live fetch / registry defaults.
    //    Provider list comes from the registry (no hardcoded array).
    const allKinds = listDefinitions().map((d) => d.kind);
    const providers: string[] = provider
      ? [provider]
      : allKinds;

    const allModels: DiscoveredModel[] = [];

    for (const p of providers) {
      if (!live) {
        const cached = this.db.getCachedModels(p as ProviderName);
        if (cached) {
          allModels.push(...cached);
          continue;
        }
      }

      const envVar = getApiKeyEnv(p);
      const apiKey = envVar ? process.env[envVar] : undefined;
      if (!apiKey) {
        allModels.push(...getHardcodedModels(p));
        continue;
      }

      try {
        const models = await this.fetchModels(p as ProviderName, apiKey);
        this.db.setCachedModels(p as ProviderName, models);
        allModels.push(...models);
      } catch {
        allModels.push(...getHardcodedModels(p));
      }
    }

    return allModels;
  }

  /**
   * Pull `provider_models` rows from the ProviderStore and shape them as
   * the legacy DiscoveredModel type. Returns [] if the store is empty or
   * unavailable so the caller can fall back to the live/hardcoded path.
   */
  private readFromProviderModels(providerFilter?: ProviderName | string): DiscoveredModel[] {
    if (!this.providerStore) return [];
    const providers = this.providerStore.listProviders({ enabled: true });
    const now = new Date().toISOString();
    const out: DiscoveredModel[] = [];
    for (const p of providers) {
      if (providerFilter && p.id !== providerFilter && p.kind !== providerFilter) continue;
      const models = this.providerStore.listModels(p.id, true);
      for (const m of models) {
        out.push({
          id: m.model_id,
          provider: (p.id as ProviderName) ?? (p.kind as ProviderName),
          name: m.name,
          capabilities: ['text'],
          cached_at: now,
        });
      }
    }
    return out;
  }

  private async fetchModels(provider: ProviderName, apiKey: string): Promise<DiscoveredModel[]> {
    const now = new Date().toISOString();

    switch (provider) {
      case 'anthropic':
        return this.fetchAnthropicModels(apiKey, now);
      case 'openai':
        return this.fetchOpenAICompatModels('https://api.openai.com/v1/models', apiKey, 'openai', now);
      case 'deepseek':
        return this.fetchOpenAICompatModels('https://api.deepseek.com/models', apiKey, 'deepseek', now);
      case 'zai':
        return this.fetchOpenAICompatModels('https://api.z.ai/api/paas/v4/models', apiKey, 'zai', now);
      case 'kimi-code':
        return this.fetchOpenAICompatModels('https://api.kimi.com/coding/v1/models', apiKey, 'kimi-code', now);
      case 'gemini':
        return this.fetchGeminiModels(apiKey, now);
      default:
        return getHardcodedModels(provider);
    }
  }

  private async fetchAnthropicModels(apiKey: string, cachedAt: string): Promise<DiscoveredModel[]> {
    const response = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });
    if (!response.ok) throw new Error(`Anthropic API error: ${response.status}`);

    const data = await response.json() as { data: Array<{ id: string; display_name?: string }> };
    return data.data.map(m => ({
      id: m.id,
      provider: 'anthropic' as ProviderName,
      name: m.display_name ?? m.id,
      capabilities: ['text'],
      cached_at: cachedAt,
    }));
  }

  private async fetchOpenAICompatModels(url: string, apiKey: string, provider: ProviderName, cachedAt: string): Promise<DiscoveredModel[]> {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(`${provider} API error: ${response.status}`);

    const data = await response.json() as { data: Array<{ id: string; owned_by?: string }> };
    return data.data.map(m => ({
      id: m.id,
      provider,
      name: m.id,
      capabilities: ['text'],
      cached_at: cachedAt,
    }));
  }

  private async fetchGeminiModels(apiKey: string, cachedAt: string): Promise<DiscoveredModel[]> {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (!response.ok) throw new Error(`Gemini API error: ${response.status}`);

    const data = await response.json() as { models: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }> };
    return data.models
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => ({
        id: m.name.replace('models/', ''),
        provider: 'gemini' as ProviderName,
        name: m.displayName ?? m.name,
        capabilities: ['text'],
        cached_at: cachedAt,
      }));
  }
}
