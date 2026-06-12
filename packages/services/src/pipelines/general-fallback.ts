/**
 * Zero-config fallback for pipeline bindings — derives a `FallbackDefault`
 * from the operator's "general AI" default model (Admin → AI Geral) so
 * best-effort pipelines (e.g. `memory_extraction`/`distiller`) work before
 * any binding row exists. The resolver consults the fallback LAST, so a
 * configured binding always wins; this only removes the silent-dead state
 * where an unset binding meant the feature never ran at all.
 */
import type { ProviderStore } from '@mcp/store/provider-store.js';
import type { FallbackDefault } from './provider-resolver.js';

export function generalDefaultAsFallback(providerStore: ProviderStore): FallbackDefault | null {
  const def = providerStore.getGeneralDefault();
  if (!def) return null;
  const provider = providerStore.getProvider(def.providerId);
  if (!provider?.enabled) return null;
  // The dashboard appends a `::mode` suffix to model ids (Z.AI coding vs
  // general); bindings keep the bare id + mode separately — split here.
  // Same convention as `callGeneralAiJson` (api-handlers/aiJson.ts).
  let modelId = def.modelId;
  let modelMode: string | undefined;
  if (modelId.includes('::')) [modelId, modelMode] = modelId.split('::', 2);
  if (!modelId) return null;
  return {
    providerId: provider.id,
    providerKind: provider.kind,
    modelId,
    modelMode,
    config: { temperature: 0 },
  };
}
