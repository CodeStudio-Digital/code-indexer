import { describe, it, expect } from 'vitest';
import {
  providerDeclSchema,
  appManifestSchema,
} from '@mcp/plugin-sdk/manifest/app-json.schema.js';
import { definePlugin, contributeProvider } from '@mcp/plugin-sdk/define.js';
import { defineProvider } from '@mcp/provider-sdk';

describe('providers contribution point', () => {
  it('providerDeclSchema accepts a full declarative provider', () => {
    const parsed = providerDeclSchema.parse({
      kind: 'acme',
      displayName: 'Acme LLM',
      credKind: 'api-key',
      envVars: ['ACME_API_KEY'],
      defaultModels: ['acme-1'],
      defaultModel: 'acme-1',
      pricing: { 'acme-1': { inputPer1M: 1, outputPer1M: 2 } },
      capabilities: { supportsThinking: true },
      visual: { icon: 'Bot', fg: 'text-red-500', bg: 'bg-red-500/15' },
      supportsCoder: true,
      supportsIndexer: false,
    });
    expect(parsed.kind).toBe('acme');
    expect(parsed.supportsCoder).toBe(true);
    // Defaults applied for omitted boolean flags.
    expect(parsed.supportsFetchModels).toBe(false);
  });

  it('rejects an unknown credKind', () => {
    expect(() =>
      providerDeclSchema.parse({ kind: 'x', displayName: 'X', credKind: 'magic' }),
    ).toThrow();
  });

  it('appManifestSchema accepts a manifest carrying providers', () => {
    const m = appManifestSchema.parse({
      worker: 'dist/plugin.js',
      providers: [{ kind: 'acme', displayName: 'Acme', credKind: 'api-key' }],
    });
    expect(m.providers?.[0]?.kind).toBe('acme');
  });

  it('definePlugin carries contributed providers (with adapter functions) through', () => {
    const acme = contributeProvider(
      defineProvider({
        kind: 'acme',
        displayName: 'Acme',
        credKind: 'api-key',
        envVars: [],
        defaultModels: ['acme-1'],
        pricing: {},
        createCoder: () => ({
          name: 'acme',
          model: 'acme-1',
          setModel() {},
          async *chat() {},
        }),
      }),
    );
    const mod = definePlugin({ providers: [acme] });
    expect(mod.providers).toHaveLength(1);
    expect(mod.providers?.[0]?.kind).toBe('acme');
    // The executable adapter survives in the runtime module (the CLI build is
    // what strips it to the declarative `.app.json` form).
    expect(typeof mod.providers?.[0]?.createCoder).toBe('function');
  });

  it('a tool-only plugin has no providers key', () => {
    const mod = definePlugin({ tools: [] });
    expect(mod.providers).toBeUndefined();
  });
});
