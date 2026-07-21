/**
 * Live model discovery for the `sdk:kimi-code` format.
 *
 * The Kimi Code format uses only the API key stored on the provider row.
 * `spec.discovery` carries no parameters, so `spec` and `store` are unused
 * beyond the shared discovery signature.
 */
import type {
  ProviderConfig,
  ProviderStore,
  UpsertModelInput,
} from '@mcp/store/provider-store.js';
import type { ProviderSpec } from '@mcp/provider-sdk';
import {
  fetchKimiCodeModels,
  kimiCodeSeedUpsertModels,
  mapKimiCodeModels,
} from '@mcp/services/services/kimi-code.js';

export async function discoverKimiCodeModels(
  _spec: ProviderSpec,
  cfg: ProviderConfig,
  _store: ProviderStore,
): Promise<UpsertModelInput[]> {
  try {
    if (!cfg.api_key) return kimiCodeSeedUpsertModels();
    const live = await fetchKimiCodeModels({
      baseURL: cfg.base_url,
      apiKey: cfg.api_key,
    });
    const mapped = mapKimiCodeModels(live);
    return mapped.length > 0 ? mapped : kimiCodeSeedUpsertModels();
  } catch {
    return kimiCodeSeedUpsertModels();
  }
}
