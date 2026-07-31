import { describe, expect, it, vi } from 'vitest';
import type { ChatDelta, ChatProvider, ProviderDefinition, ProviderSpec } from '@mcp/provider-sdk';

const { importBundleMock } = vi.hoisted(() => ({ importBundleMock: vi.fn() }));

vi.mock('../import-plugin-bundle.js', () => ({ importPluginBundle: importBundleMock }));

import { buildProviderPluginDefinition } from '../provider-adapter-definition.js';

const spec: ProviderSpec = {
  kind: 'acme',
  displayName: 'Acme',
  credKind: 'api-key',
  envVars: [],
  defaultModels: ['acme-default'],
  pricing: {},
  wire: 'openai-compat',
};

describe('buildProviderPluginDefinition host wire fallback', () => {
  it('keeps auth/discovery in the plugin and shared runtime methods in the host', async () => {
    importBundleMock.mockResolvedValue({
      providerAdapter: {
        sdkVersion: 2,
        kind: 'acme',
        resolveCredentials: vi.fn(async () => ({ apiKey: 'plugin-key' })),
      },
    });

    const hostClient: ChatProvider = {
      name: 'acme',
      model: 'acme-model',
      setModel: vi.fn(function setModel(this: ChatProvider, model: string) { this.model = model; }),
      async *chat() { yield { type: 'text_delta', text: 'ok' } satisfies ChatDelta; },
    };
    const hostCreateImages = vi.fn() as NonNullable<ProviderDefinition['createImages']>;
    const hostDefinition: ProviderDefinition = {
      kind: 'acme',
      displayName: 'Acme',
      credKind: 'api-key',
      envVars: [],
      defaultModels: ['acme-default'],
      pricing: {},
      fetchModels: vi.fn(async () => ['from-host']),
      testConnection: vi.fn(async () => undefined),
      createCoder: vi.fn(() => hostClient),
      createImages: hostCreateImages,
    };
    const definition = buildProviderPluginDefinition(spec, {
      namespace: 'provider-acme',
      file: 'C:\\plugins\\provider-acme\\dist\\plugin.js',
      kinds: ['acme'],
    }, hostDefinition);
    const creds = { apiKey: 'key' };

    await expect(definition.fetchModels?.(creds)).resolves.toEqual(['from-host']);
    const config = { id: 'acme-1', kind: 'acme' };
    await definition.testConnection?.({ config, creds });
    const client = definition.createCoder?.(creds, 'chosen-model');
    const chunks: ChatDelta[] = [];
    for await (const chunk of client!.chat({} as never)) chunks.push(chunk);

    expect(hostDefinition.fetchModels).toHaveBeenCalledWith(creds);
    expect(hostDefinition.testConnection).toHaveBeenCalledWith({ config, creds });
    expect(hostDefinition.createCoder).toHaveBeenCalledWith(creds, 'chosen-model', undefined);
    expect(definition.createImages).toBe(hostCreateImages);
    expect(chunks).toEqual([{ type: 'text_delta', text: 'ok' }]);
  });
});
