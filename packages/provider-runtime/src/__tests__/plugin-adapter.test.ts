import { describe, expect, it } from 'vitest';
import type { ProviderSpec } from '@mcp/provider-sdk';
import { defineProviderAdapterFromSpec } from '../plugin-adapter.js';

describe('defineProviderAdapterFromSpec', () => {
  it('does not embed host wire implementations in the plugin adapter', async () => {
    const spec: ProviderSpec = {
      kind: 'acme',
      displayName: 'Acme',
      credKind: 'api-key',
      envVars: ['ACME_API_KEY'],
      defaultBaseURL: 'https://acme.invalid/v1',
      defaultModels: ['acme-model'],
      pricing: {},
      wire: 'openai-compat',
    };

    const adapter = defineProviderAdapterFromSpec(spec);

    await expect(adapter.resolveCredentials?.({
      config: { id: 'acme-1', kind: 'acme', api_key: 'secret' },
      credentials: {
        get: async () => null,
        set: async () => undefined,
        mirrorApiKey: async () => undefined,
        clear: async () => undefined,
      },
      fetch: globalThis.fetch,
      log: () => undefined,
    })).resolves.toMatchObject({ apiKey: 'secret', baseURL: spec.defaultBaseURL });
    expect(adapter.fetchModels).toBeUndefined();
    expect(adapter.testConnection).toBeUndefined();
    expect(adapter.createCoder).toBeUndefined();
  });
});
