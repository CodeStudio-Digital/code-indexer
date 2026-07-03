/**
 * Live model discovery for the `sdk:kimi-code` format.
 *
 * The Kimi Code format derives everything from the OAuth-resolved credentials
 * (`resolveKimiCodeCreds`) plus the provider row; `spec.discovery` carries no
 * parameters, so `spec` is unused beyond the signature. The `store` is required
 * to force-refresh the token on a 401 and to back `resolveKimiCodeCreds`.
 */
import type {
  ProviderConfig,
  ProviderStore,
  UpsertModelInput,
} from '@mcp/store/provider-store.js';
import type { ProviderSpec } from '@mcp/provider-sdk';
import { resolveKimiCodeCreds } from '@mcp/services/providers/shared/oauth.js';
import {
  fetchKimiCodeModels,
  kimiCodeSeedUpsertModels,
  mapKimiCodeModels,
  refreshIfExpired as refreshKimiCodeToken,
} from '@mcp/services/services/oauth/kimi-code.js';

export async function discoverKimiCodeModels(
  _spec: ProviderSpec,
  cfg: ProviderConfig,
  store: ProviderStore,
): Promise<UpsertModelInput[]> {
  try {
    const creds = await resolveKimiCodeCreds(cfg);
    let live;
    try {
      live = await fetchKimiCodeModels({
        baseURL: creds.baseURL ?? cfg.base_url,
        apiKey: creds.apiKey,
        headers: creds.extraHeaders,
      });
    } catch (e) {
      if (!/HTTP 401/.test((e as Error).message)) throw e;
      const fresh = await refreshKimiCodeToken(store, cfg.id, { force: true });
      live = await fetchKimiCodeModels({
        baseURL: creds.baseURL ?? cfg.base_url,
        apiKey: fresh ?? creds.apiKey,
        headers: creds.extraHeaders,
      });
    }
    const mapped = mapKimiCodeModels(live);
    return mapped.length > 0 ? mapped : kimiCodeSeedUpsertModels();
  } catch {
    return kimiCodeSeedUpsertModels();
  }
}
