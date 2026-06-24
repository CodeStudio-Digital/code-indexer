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
import { requestFetchHeaders } from '../wire-helpers/request.js';

export async function discoverOpenAIModels(
  spec: ProviderSpec,
  cfg: ProviderConfig,
): Promise<UpsertModelInput[]> {
  // Provider-level plan mode (e.g. extra.zai_mode='coding') → list that plan's
  // endpoint's models. Falls back to the spec's modelsUrl / base_url otherwise.
  const mm = spec.wireOpts?.modelModes;
  const planMode = mm?.defaultModeKey ? (cfg.extra?.[mm.defaultModeKey] as string | undefined) : undefined;
  const base =
    planMode && mm?.map[planMode]
      ? `${mm.map[planMode].baseURL.replace(/\/$/, '')}/models`
      : (spec.discovery?.modelsUrl ??
        `${(cfg.base_url ?? spec.defaultBaseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/models`);
  // Honor a `request.auth`/`request.headers` override so a custom OpenAI-compatible
  // vendor's /models discovery uses the same auth as its chat call. Byte-identical
  // (returns the native Bearer header) when no `request` descriptor is set.
  const headers = requestFetchHeaders(
    spec,
    { apiKey: cfg.api_key ?? undefined, baseURL: base, creds: { apiKey: cfg.api_key ?? undefined, extra: cfg.extra ?? undefined } },
    { Authorization: `Bearer ${cfg.api_key ?? ''}` },
    'Authorization',
  );
  const r = await fetch(base, { headers });
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

  // Legacy duplication (normal+coding variants) only when NO plan mode is
  // selected — preserves behavior for older zai rows that set the flag.
  if (!planMode && spec.discovery?.supportsModes && cfg.extra?.zai_has_coding_mode === true) {
    return list.flatMap((m) => [
      { ...m, mode: 'normal', name: `${m.name} (normal)` },
      { ...m, mode: 'coding', name: `${m.name} (coding)` },
    ]);
  }

  return list;
}
