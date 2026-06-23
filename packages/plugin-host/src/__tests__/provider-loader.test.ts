import { describe, it, expect, vi } from 'vitest';
import { loadPluginProviders, type ProviderPluginRef } from '../provider-loader.js';
import type { ProviderDefinition } from '@mcp/provider-sdk';
import type { PluginModule } from '@mcp/plugin-sdk';

function fakeProvider(kind: string): ProviderDefinition {
  return {
    kind,
    displayName: kind,
    credKind: 'api-key',
    envVars: [],
    defaultModels: [`${kind}-1`],
    pricing: {},
    createCoder: () => ({ name: kind, model: `${kind}-1`, setModel() {}, async *chat() {} }),
  };
}

function ref(namespace: string, kinds: string[], over: Partial<ProviderPluginRef> = {}): ProviderPluginRef {
  return {
    namespace,
    bundleFile: `/plugins/${namespace}/dist/plugin.js`,
    providerKinds: kinds,
    signature: null,
    source: 'local',
    ...over,
  };
}

function moduleWith(kinds: string[]): { default: PluginModule } {
  return { default: { tools: [], toolWindows: [], commands: [], themes: [], providers: kinds.map(fakeProvider) } };
}

describe('loadPluginProviders', () => {
  it('registers providers from a trusted plugin bundle', async () => {
    const register = vi.fn();
    const res = await loadPluginProviders({
      register,
      trust: () => true,
      refs: [ref('acme', ['acme'])],
      importBundle: async () => moduleWith(['acme']),
    });
    expect(register).toHaveBeenCalledTimes(1);
    expect((register.mock.calls[0][0] as ProviderDefinition).kind).toBe('acme');
    expect(res.loaded).toEqual([{ namespace: 'acme', kinds: ['acme'] }]);
    expect(res.skipped).toEqual([]);
  });

  it('skips an untrusted plugin WITHOUT importing its bundle', async () => {
    const register = vi.fn();
    const importBundle = vi.fn(async () => moduleWith(['evil']));
    const res = await loadPluginProviders({
      register,
      trust: () => false,
      refs: [ref('evil', ['evil'])],
      importBundle,
    });
    expect(importBundle).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(res.skipped).toEqual(['evil']);
    expect(res.loaded).toEqual([]);
  });

  it('isolates a broken bundle — others still load, no throw', async () => {
    const register = vi.fn();
    const onError = vi.fn();
    const res = await loadPluginProviders({
      register,
      trust: () => true,
      refs: [ref('bad', ['bad']), ref('good', ['good'])],
      importBundle: async (file) => {
        if (file.includes('/bad/')) throw new Error('boom');
        return moduleWith(['good']);
      },
      onError,
    });
    expect(onError).toHaveBeenCalledWith('bad', expect.any(Error));
    expect(res.skipped).toEqual(['bad']);
    expect(res.loaded).toEqual([{ namespace: 'good', kinds: ['good'] }]);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('registers every provider when a plugin contributes several', async () => {
    const register = vi.fn();
    const res = await loadPluginProviders({
      register,
      trust: () => true,
      refs: [ref('multi', ['a', 'b'])],
      importBundle: async () => moduleWith(['a', 'b']),
    });
    expect(register).toHaveBeenCalledTimes(2);
    expect(res.loaded).toEqual([{ namespace: 'multi', kinds: ['a', 'b'] }]);
  });
});
