/**
 * Live model discovery for the `anthropic-models` format.
 *
 * Lifted verbatim from the hand-written admin helper
 * `apps/http-api/admin/model-discovery/anthropic.ts` (`discoverAnthropic`).
 * The behaviour is identical — the equivalence test asserts deep equality of
 * the returned `UpsertModelInput[]`.
 *
 * The Anthropic format takes no parameters from `spec.discovery` (the URL is
 * fixed at `/v1/models` and the base URL is derived from the provider row), so
 * `spec` is unused beyond the signature.
 */
import type { ProviderConfig, UpsertModelInput } from '@mcp/store/provider-store.js';
import { getRegistryContextWindow } from '@mcp/code-agent/providers/capabilities.js';
import type { ProviderSpec } from '@mcp/provider-sdk';

export async function discoverAnthropicModels(
  _spec: ProviderSpec,
  cfg: ProviderConfig,
): Promise<UpsertModelInput[]> {
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
