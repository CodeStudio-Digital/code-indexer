/**
 * openai-models live discovery (declarative).
 *
 * Lifts the hand-written admin `discoverOpenai` / `discoverMoonshot` (same
 * OpenAI-compatible `{base_url}/models` family) into a spec-driven builder. The
 * output is byte-for-byte identical to those functions:
 *
 *  - base URL: `spec.discovery.modelsUrl` override, else `{base_url ?? defaultBaseURL
 *    ?? api.openai.com}/models` (trailing slash trimmed).
 *  - `filterPrefixes` reproduces Moonshot's `kimi-`/`moonshot-` allow-list.
 *  - `supportsModes` + `cfg.extra.zai_has_coding_mode` reproduces ZAI's
 *    normal/coding duplication.
 *
 * The equivalence tests (discovery-openai-models.test.ts) assert deepEqual
 * against the admin functions for the OpenAI/Moonshot cases; the ZAI case is the
 * new capability (no admin discoverX exists for kind 'zai').
 */
import type { ProviderConfig, UpsertModelInput } from '@mcp/store/provider-store.js';
import { getRegistryContextWindow } from '@mcp/code-agent/providers/capabilities.js';
import type { ProviderSpec } from '@mcp/provider-sdk';

export async function discoverOpenAIModels(
  spec: ProviderSpec,
  cfg: ProviderConfig,
): Promise<UpsertModelInput[]> {
  const base =
    spec.discovery?.modelsUrl ??
    `${(cfg.base_url ?? spec.defaultBaseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/models`;
  const r = await fetch(base, { headers: { Authorization: `Bearer ${cfg.api_key ?? ''}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = (await r.json()) as { data?: { id?: string }[] };
  let list: UpsertModelInput[] = (data.data ?? [])
    .filter((m) => m.id)
    .map((m) => ({
      model_id: m.id!,
      name: m.id!,
      context_window: getRegistryContextWindow(m.id!),
      source: 'live' as const,
    }));

  const filterPrefixes = spec.discovery?.filterPrefixes;
  if (filterPrefixes?.length) {
    list = list.filter((m) => filterPrefixes.some((p) => m.model_id.startsWith(p)));
  }

  if (spec.discovery?.supportsModes && cfg.extra?.zai_has_coding_mode === true) {
    return list.flatMap((m) => [
      { ...m, mode: 'normal', name: `${m.name} (normal)` },
      { ...m, mode: 'coding', name: `${m.name} (coding)` },
    ]);
  }

  return list;
}
