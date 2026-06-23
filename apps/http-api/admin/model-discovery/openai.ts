/**
 * OpenAI-compatible model discovery.
 *
 * ZAI exposes a `zai_has_coding_mode` flag in provider.extra — when set, we
 * duplicate each model as normal+coding so the UI can pick a mode.
 */
import type { ProviderConfig, UpsertModelInput } from '@mcp/store/provider-store.js';
import { getRegistryContextWindow } from '@mcp/code-agent/providers/capabilities.js';

export async function discoverOpenai(cfg: ProviderConfig): Promise<UpsertModelInput[]> {
  const { api_key, base_url } = cfg;
  const base = base_url ?? 'https://api.openai.com/v1';
  const url = base.endsWith('/') ? `${base}models` : `${base}/models`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${api_key ?? ''}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = (await r.json()) as { data: { id: string }[] };
  const base_list: UpsertModelInput[] = data.data.map((m) => ({
    model_id: m.id,
    name: m.id,
    context_window: getRegistryContextWindow(m.id),
    source: 'live' as const,
  }));
  if (cfg.extra?.zai_has_coding_mode === true) {
    return base_list.flatMap((m) => [
      { ...m, mode: 'normal', name: `${m.name} (normal)` },
      { ...m, mode: 'coding', name: `${m.name} (coding)` },
    ]);
  }
  return base_list;
}
