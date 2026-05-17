import type {
  ProviderStore,
  ProviderConfig,
  UpsertModelInput,
} from '@mcp/store/provider-store.js';
import { resolveKimiCodeCreds } from '@mcp/services/providers/shared/oauth.js';
import {
  fetchKimiCodeModels,
  kimiCodeSeedUpsertModels,
  mapKimiCodeModels,
  refreshIfExpired as refreshKimiCodeToken,
} from '@mcp/services/services/oauth/kimi-code.js';

export async function discoverKimiCode(
  _store: ProviderStore,
  cfg: ProviderConfig,
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
      const fresh = await refreshKimiCodeToken(_store, cfg.id, { force: true });
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
