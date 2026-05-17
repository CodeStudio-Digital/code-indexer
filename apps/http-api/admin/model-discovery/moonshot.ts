/**
 * Moonshot Open Platform live discovery.
 *
 * Calls the OpenAI-compatible `{base_url}/models` endpoint with the
 * static API key from `cfg.api_key`. Filters to the `kimi-*` and
 * `moonshot-*` model families — Moonshot's catalog occasionally lists
 * other entries (embedding helpers, deprecated aliases) that the
 * coder/indexer can't drive.
 */
import type { ProviderConfig, UpsertModelInput } from '@mcp/store/provider-store.js';
import { getRegistryContextWindow } from '@mcp/code-agent/providers/capabilities.js';

const ALLOWED_PREFIXES = ['kimi-', 'moonshot-'] as const;

export async function discoverMoonshot(cfg: ProviderConfig): Promise<UpsertModelInput[]> {
  const base = (cfg.base_url ?? 'https://api.moonshot.ai/v1').replace(/\/$/, '');
  const url = `${base}/models`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${cfg.api_key ?? ''}` },
  });
  if (!r.ok) throw new Error(`Moonshot API error: HTTP ${r.status}`);
  const body = (await r.json()) as { data?: Array<{ id?: string }> };
  const out: UpsertModelInput[] = [];
  for (const m of body.data ?? []) {
    const id = m.id;
    if (!id) continue;
    if (!ALLOWED_PREFIXES.some((p) => id.startsWith(p))) continue;
    out.push({
      model_id: id,
      name: id,
      context_window: getRegistryContextWindow(id),
      source: 'live' as const,
    });
  }
  return out;
}
