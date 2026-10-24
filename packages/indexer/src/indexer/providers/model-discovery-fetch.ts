import type { DiscoveredModel, ProviderName } from '@mcp/shared/types.js';
import { readBoundedJsonResponse } from '@mcp/shared/utils/bounded-json-response.js';

const endpoints: Record<string, string> = {
  anthropic: 'https://api.anthropic.com/v1/models', openai: 'https://api.openai.com/v1/models',
  openrouter: 'https://openrouter.ai/api/v1/models', deepseek: 'https://api.deepseek.com/models',
  zai: 'https://api.z.ai/api/paas/v4/models', 'kimi-code': 'https://api.kimi.com/coding/v1/models',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models',
};

/** This legacy catalog path uses only fixed public endpoints. OAuth and plugin
 * catalog refresh remain with their admin owner; no token refresh runs here. */
export async function fetchDiscoveryModels(provider: ProviderName, apiKey: string, signal: AbortSignal): Promise<DiscoveredModel[]> {
  const url = endpoints[provider];
  if (!url) throw new Error('Live listing is not supported by this catalog reader');
  const headers: Record<string, string> = provider === 'anthropic'
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : provider === 'gemini' ? { 'x-goog-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` };
  const response = await fetch(url, { headers, signal, redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Model catalog returned HTTP ${response.status}`);
  }
  const value = await readBoundedJsonResponse(response, signal, 4 * 1024 * 1024) as Record<string, unknown> | null;
  const rows = value?.[provider === 'gemini' ? 'models' : 'data'];
  if (!Array.isArray(rows) || rows.length > 10_000) throw new Error('Invalid or oversized model catalog');
  const cached_at = new Date().toISOString(), models: DiscoveredModel[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') throw new Error('Invalid model catalog entry');
    if (provider === 'gemini' && !row.supportedGenerationMethods?.includes('generateContent')) continue;
    const id = provider === 'gemini' ? row.name?.replace(/^models\//, '') : row.id;
    const name = provider === 'gemini' ? row.displayName ?? row.name : row.display_name ?? id;
    if (typeof id !== 'string' || !id || id.length > 1024 || typeof name !== 'string' || name.length > 4096) {
      throw new Error('Invalid model catalog identity');
    }
    models.push({ id, provider, name, capabilities: ['text'], cached_at });
  }
  signal.throwIfAborted();
  return models;
}
