/**
 * Anthropic model discovery via /v1/models.
 */
import type { ProviderConfig, UpsertModelInput } from '@mcp/store/provider-store.js';
import { getRegistryContextWindow } from '@mcp/code-agent/providers/capabilities.js';

export async function discoverAnthropic(cfg: ProviderConfig): Promise<UpsertModelInput[]> {
  const { api_key, base_url } = cfg;
  const base = (base_url ?? 'https://api.anthropic.com').replace(/\/$/, '');
  const r = await fetch(`${base}/v1/models`, {
    headers: {
      'x-api-key': api_key ?? '',
      'anthropic-version': '2023-06-01',
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = (await r.json()) as { data: { id: string; display_name?: string }[] };
  return data.data.map((m) => ({
    model_id: m.id,
    name: m.display_name ?? m.id,
    context_window: getRegistryContextWindow(m.id),
    source: 'live' as const,
  }));
}
