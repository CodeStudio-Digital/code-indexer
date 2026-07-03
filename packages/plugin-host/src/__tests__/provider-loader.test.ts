import { describe, it, expect, vi } from 'vitest';
import { loadPluginProviders, type ProviderPluginRef } from '../provider-loader.js';
import type { ProviderDefinition, ProviderSpec } from '@mcp/provider-sdk';

/** A minimal valid declarative spec (passes thirdPartyProviderSpecSchema). */
const validSpec = (kind: string): Record<string, unknown> => ({
  kind,
  displayName: kind,
  credKind: 'api-key',
  envVars: [],
  defaultModels: [`${kind}-1`],
  pricing: {},
  wire: 'openai-compat',
});

const fakeDef = (spec: ProviderSpec): ProviderDefinition => ({
  kind: spec.kind,
  displayName: spec.displayName,
  credKind: spec.credKind,
  envVars: spec.envVars,
  defaultModels: spec.defaultModels,
  pricing: spec.pricing,
  createCoder: () => ({ name: spec.kind, model: `${spec.kind}-1`, setModel() {}, async *chat() {} }),
});

const ref = (namespace: string, specs: unknown[], over: Partial<ProviderPluginRef> = {}): ProviderPluginRef => ({
  namespace,
  specs,
  signature: null,
  source: 'local',
  runtime: null,
  ...over,
});

describe('loadPluginProviders (declarative DATA → buildDefinition → register)', () => {
  it('validates + builds + registers a provider from a declarative spec (no bundle import)', () => {
    const register = vi.fn();
    const buildDefinition = vi.fn(fakeDef);
    const res = loadPluginProviders({ register, buildDefinition, refs: [ref('acme', [validSpec('acme')])] });
    expect(buildDefinition).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(1);
    expect((register.mock.calls[0][0] as ProviderDefinition).kind).toBe('acme');
    expect(res.loaded).toEqual([{ namespace: 'acme', kinds: ['acme'] }]);
    expect(res.skipped).toEqual([]);
  });

  it('rejects a spec with a host-only field (auth.hooks) — skipped, never built/registered', () => {
    const register = vi.fn();
    const buildDefinition = vi.fn(fakeDef);
    const onError = vi.fn();
    const evil = { ...validSpec('evil'), auth: { mode: 'oauth', hooks: 'anthropic' } };
    const res = loadPluginProviders({ register, buildDefinition, refs: [ref('evil', [evil])], onError });
    expect(buildDefinition).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
    expect(res.skipped).toEqual(['evil']);
  });

  it('rejects an unknown wire at the schema (escape hatch, fail-closed)', () => {
    const register = vi.fn();
    const res = loadPluginProviders({
      register,
      buildDefinition: vi.fn(fakeDef),
      refs: [ref('w', [{ ...validSpec('w'), wire: 'made-up-protocol' }])],
      onError: vi.fn(),
    });
    expect(register).not.toHaveBeenCalled();
    expect(res.skipped).toEqual(['w']);
  });

  it('rejects a spec that shadows a built-in kind (reservedKinds)', () => {
    const register = vi.fn();
    const onError = vi.fn();
    const res = loadPluginProviders({
      register,
      buildDefinition: vi.fn(fakeDef),
      reservedKinds: new Set(['anthropic']),
      refs: [ref('spoof', [validSpec('anthropic')])],
      onError,
    });
    expect(register).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
    expect(res.skipped).toEqual(['spoof']);
  });

  it('isolates a buildDefinition throw — sibling specs still register', () => {
    const register = vi.fn();
    const onError = vi.fn();
    const buildDefinition = vi.fn((spec: ProviderSpec) => {
      if (spec.kind === 'bad') throw new Error('boom');
      return fakeDef(spec);
    });
    const res = loadPluginProviders({
      register,
      buildDefinition,
      refs: [ref('p', [validSpec('bad'), validSpec('good')])],
      onError,
    });
    expect(onError).toHaveBeenCalledWith('p', expect.any(Error));
    expect(register).toHaveBeenCalledTimes(1);
    expect(res.loaded).toEqual([{ namespace: 'p', kinds: ['good'] }]);
    expect(res.skipped).toEqual(['p']);
  });

  it('optional trust predicate can deny a namespace', () => {
    const register = vi.fn();
    const res = loadPluginProviders({
      register,
      buildDefinition: vi.fn(fakeDef),
      trust: () => false,
      refs: [ref('x', [validSpec('x')])],
    });
    expect(register).not.toHaveBeenCalled();
    expect(res.skipped).toEqual(['x']);
  });

  it('firstParty (blessed) ref may declare host-only auth.hooks (full schema)', () => {
    const register = vi.fn();
    const onError = vi.fn();
    const blessedSpec = { ...validSpec('copilot'), credKind: 'oauth', auth: { mode: 'oauth', flavor: 'pat-exchange', hooks: 'copilot' } };
    const res = loadPluginProviders({
      register,
      buildDefinition: vi.fn(fakeDef),
      firstParty: (r) => r.source === 'bundled',
      refs: [ref('provider-copilot', [blessedSpec], { source: 'bundled' })],
      onError,
    });
    expect(onError).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledTimes(1);
    expect(res.loaded).toEqual([{ namespace: 'provider-copilot', kinds: ['copilot'] }]);
  });

  it('firstParty ref is EXEMPT from reservedKinds (owns its built-in kind)', () => {
    const register = vi.fn();
    const res = loadPluginProviders({
      register,
      buildDefinition: vi.fn(fakeDef),
      firstParty: (r) => r.source === 'bundled',
      reservedKinds: new Set(['anthropic']),
      refs: [ref('provider-anthropic', [validSpec('anthropic')], { source: 'bundled' })],
    });
    expect(register).toHaveBeenCalledTimes(1);
    expect(res.loaded).toEqual([{ namespace: 'provider-anthropic', kinds: ['anthropic'] }]);
  });

  it('firstParty ref with providerRuntime registers a plugin-owned adapter definition', () => {
    const register = vi.fn();
    const buildDefinition = vi.fn(fakeDef);
    const res = loadPluginProviders({
      register,
      buildDefinition,
      firstParty: (r) => r.source === 'bundled',
      refs: [
        ref('provider-acme', [validSpec('acme')], {
          source: 'bundled',
          runtime: {
            namespace: 'provider-acme',
            file: '/tmp/provider-acme/dist/plugin.js',
            kinds: ['acme'],
          },
        }),
      ],
    });
    expect(buildDefinition).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledTimes(1);
    expect((register.mock.calls[0][0] as ProviderDefinition).resolveCredentials).toEqual(expect.any(Function));
    expect(res.loaded).toEqual([{ namespace: 'provider-acme', kinds: ['acme'] }]);
  });

  it('a NON-firstParty ref with host-only auth.hooks is still rejected (third-party gate)', () => {
    const register = vi.fn();
    const onError = vi.fn();
    const evil = { ...validSpec('evil'), credKind: 'oauth', auth: { mode: 'oauth', hooks: 'copilot' } };
    const res = loadPluginProviders({
      register,
      buildDefinition: vi.fn(fakeDef),
      firstParty: (r) => r.source === 'bundled', // evil is source 'local' → not blessed
      refs: [ref('evil', [evil])],
      onError,
    });
    expect(register).not.toHaveBeenCalled();
    expect(res.skipped).toEqual(['evil']);
  });
});
