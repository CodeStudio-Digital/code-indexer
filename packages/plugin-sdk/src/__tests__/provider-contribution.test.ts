import { describe, it, expect } from 'vitest';
import { appManifestSchema } from '@mcp/plugin-sdk/manifest/app-json.schema.js';
import { definePlugin, contributeProvider } from '@mcp/plugin-sdk/define.js';
import { defineProviderSpec } from '@mcp/provider-sdk';

const acmeSpec = {
  kind: 'acme',
  displayName: 'Acme LLM',
  credKind: 'api-key' as const,
  envVars: ['ACME_API_KEY'],
  defaultModels: ['acme-1'],
  defaultModel: 'acme-1',
  pricing: { 'acme-1': { inputPer1M: 1, outputPer1M: 2 } },
  capabilities: { supportsThinking: true },
  visual: { icon: 'Bot', fg: 'text-red-500', bg: 'bg-red-500/15' },
  wire: 'openai-compat' as const,
};

describe('declarative providers contribution point', () => {
  it('appManifestSchema accepts a manifest carrying a full ProviderSpec', () => {
    const m = appManifestSchema.parse({ worker: 'dist/plugin.js', providers: [acmeSpec] });
    expect(m.providers?.[0]?.kind).toBe('acme');
    expect(m.providers?.[0]?.wire).toBe('openai-compat');
  });

  it('rejects a provider that claims a host-only capability (auth.hooks)', () => {
    expect(() =>
      appManifestSchema.parse({ providers: [{ ...acmeSpec, auth: { mode: 'oauth', hooks: 'anthropic' } }] }),
    ).toThrow();
  });

  it('rejects a provider with an unknown wire (escape hatch)', () => {
    expect(() => appManifestSchema.parse({ providers: [{ ...acmeSpec, wire: 'made-up' }] })).toThrow();
  });

  it('rejects an unknown credKind', () => {
    expect(() => appManifestSchema.parse({ providers: [{ ...acmeSpec, credKind: 'magic' }] })).toThrow();
  });

  it('definePlugin + contributeProvider carry a ProviderSpec (pure DATA, no functions)', () => {
    const acme = contributeProvider(defineProviderSpec(acmeSpec));
    const mod = definePlugin({ providers: [acme] });
    expect(mod.providers).toHaveLength(1);
    expect(mod.providers?.[0]?.kind).toBe('acme');
    expect((mod.providers?.[0] as unknown as Record<string, unknown>).createCoder).toBeUndefined();
  });

  it('a tool-only plugin has no providers key', () => {
    expect(definePlugin({ tools: [] }).providers).toBeUndefined();
  });
});
