/**
 * openai-models live discovery (declarative).
 *
 * Spec-driven discovery for the OpenAI-compatible `{base_url}/models` family:
 *
 *  - base URL: `spec.discovery.modelsUrl` override, else `{base_url ?? defaultBaseURL
 *    ?? api.openai.com}/models` (trailing slash trimmed).
 *  - `filterPrefixes` reproduces Moonshot's `kimi-`/`moonshot-` allow-list.
 *  - `supportsModes` + `cfg.extra.zai_has_coding_mode` reproduces ZAI's
 *    normal/coding duplication.
 */
import type { ProviderConfig, UpsertModelInput } from '@mcp/store/provider-store.js';
import { getRegistryContextWindow } from '@mcp/code-agent/providers/capabilities.js';
import type { ProviderSpec } from '@mcp/provider-sdk';
import { requestFetchHeaders } from '../wire-helpers/request.js';
import { isOpenAIImageModelId, IMAGE_MODEL_MODE } from './image-model-ids.js';

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
  const data = (await r.json()) as {
    data?: Array<{
      id?: string;
      capabilities?: Record<string, boolean | undefined>;
    }>;
  };
  const requiredCapabilities = spec.discovery?.requiredCapabilities ?? [];
  let list: UpsertModelInput[] = (data.data ?? [])
    .filter(
      (m) =>
        m.id &&
        requiredCapabilities.every((capability) => m.capabilities?.[capability] === true),
    )
    .map((m) => ({
      model_id: m.id!,
      name: m.id!,
      context_window: getRegistryContextWindow(m.id!),
      source: 'live' as const,
      // Family-based tagging (gpt-image-*, dall-e-*) so image models surface
      // in the image-role pickers instead of masquerading as chat models.
      ...(isOpenAIImageModelId(m.id!) ? { mode: IMAGE_MODEL_MODE } : {}),
    }));

  const filterPrefixes = spec.discovery?.filterPrefixes;
  if (filterPrefixes?.length) {
    list = list.filter((m) => filterPrefixes.some((p) => m.model_id.startsWith(p)));
  }

  // Gap-fill from the spec's per-model seed metadata. The bare `/models` listing
  // only carries an id (no reasoning levels, max tokens, …), so a provider whose
  // models DON'T self-describe over the wire (e.g. Fugu's reasoning_effort levels)
  // can declare them as DATA via `spec.models`. Inert for every provider that
  // omits `models`; `??`-fill is purely additive (live discovery stays the source
  // of truth — it can only fill fields the API left empty, never override them).
  const seed = spec.models;
  if (seed) {
    list = list.map((m) => {
      const meta = seed[m.model_id];
      if (!meta) return m;
      return {
        ...m,
        context_window: m.context_window ?? meta.contextWindow ?? null,
        default_max_tokens: m.default_max_tokens ?? meta.maxTokens ?? null,
        can_reason:
          m.can_reason
          ?? meta.canReason
          ?? (meta.supportedReasoningLevels != null || meta.defaultReasoningLevel != null),
        supports_attachments: m.supports_attachments ?? meta.supportsAttachments ?? false,
        input_modalities: m.input_modalities ?? meta.inputModalities ?? null,
        supported_reasoning_levels: m.supported_reasoning_levels ?? meta.supportedReasoningLevels ?? null,
        default_reasoning_level: m.default_reasoning_level ?? meta.defaultReasoningLevel ?? null,
        apply_patch_tool_type: m.apply_patch_tool_type ?? meta.applyPatchToolType ?? null,
      };
    });
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
