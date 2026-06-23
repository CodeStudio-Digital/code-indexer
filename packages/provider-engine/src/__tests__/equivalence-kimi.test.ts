import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedCreds } from '@mcp/provider-sdk';

// Capture constructor args so we can assert the engine wire builds the SAME
// adapter the hand-written definition does. Both the definition and the wire
// import these exact specifiers, so one mock intercepts both.
const chatCalls: Array<Record<string, unknown>> = [];
const idxCalls: Array<{ cls: string; args: unknown[] }> = [];

vi.mock('@mcp/code-agent/providers/kimi-code.js', () => ({
  KimiCodeChatProvider: vi.fn().mockImplementation(function (opts: Record<string, unknown>) {
    chatCalls.push(opts);
  }),
}));
vi.mock('@mcp/indexer/indexer/providers/kimi-code.js', () => ({
  KimiCodeProvider: vi.fn().mockImplementation(function (...args: unknown[]) {
    idxCalls.push({ cls: 'KimiCodeProvider', args });
  }),
}));
// The kimi-code DEFINITION imports `getStore` from the services store shim,
// which transitively loads `@mcp/store` → `provider/seed.ts` → the services
// registry barrel, re-entering it mid-evaluation and yielding an `undefined`
// definition (registry.ts: `def.kind` on undefined). `getStore` is only used by
// `testConnection`, which this equivalence test does not exercise, so stub it.
vi.mock('@mcp/services/providers/shared/store.js', () => ({
  getStore: () => null,
  __setStoreForTests: () => {},
}));

import { kimiCode } from '@mcp/services/providers/definitions/kimi-code.js';
import { buildKimi } from '../wires/kimi.js';
import { kimiCodeSpec } from '../specs/kimi.js';

/** Trailing `undefined` args == not passing them (optional ctor params). */
function stripTrailingUndefined(args: unknown[]): unknown[] {
  const out = [...args];
  while (out.length > 0 && out[out.length - 1] === undefined) out.pop();
  return out;
}

const engine = buildKimi(kimiCodeSpec);

describe('kimi equivalence: engine(spec) == definition', () => {
  beforeEach(() => {
    chatCalls.length = 0;
    idxCalls.length = 0;
  });

  it('metadata matches', () => {
    // The dispatcher maps spec → definition 1:1, so the spec metadata is the
    // source the built definition would expose. Pin every compared field.
    expect(kimiCodeSpec.kind).toBe(kimiCode.kind);
    expect(kimiCodeSpec.displayName).toBe(kimiCode.displayName);
    expect(kimiCodeSpec.credKind).toBe(kimiCode.credKind);
    expect(kimiCodeSpec.envVars).toEqual(kimiCode.envVars);
    expect(kimiCodeSpec.defaultBaseURL).toBe(kimiCode.defaultBaseURL);
    expect(kimiCodeSpec.defaultModels).toEqual(kimiCode.defaultModels);
    expect(kimiCodeSpec.defaultModel).toBe(kimiCode.defaultModel);
    expect(kimiCodeSpec.pricing).toEqual(kimiCode.pricing);
    expect(kimiCodeSpec.capabilities).toEqual(kimiCode.capabilities);
    expect(kimiCodeSpec.visual).toEqual(kimiCode.visual);
  });

  // Representative creds: explicit baseURL override + extra.thinkingMode honored,
  // plus extraHeaders threaded through to defaultHeaders.
  const CREDS: ResolvedCreds = {
    apiKey: 'tok-123',
    baseURL: 'https://api.kimi.com/coding/v1-custom',
    extraHeaders: { 'X-Msh-Device-Id': 'dev-1' },
    extra: { thinkingMode: 'enabled' },
  };

  it('createCoder builds an identical adapter', () => {
    kimiCode.createCoder!(CREDS, undefined);
    const a = chatCalls[0];
    engine.createCoder!(CREDS, undefined);
    const b = chatCalls[1];
    expect(b).toEqual(a);
  });

  it('createCoder honors an explicit model + default thinking mode', () => {
    const creds: ResolvedCreds = { apiKey: 'k' }; // no baseURL, no extra → defaults
    kimiCode.createCoder!(creds, 'kimi-k2-thinking');
    const a = chatCalls[0];
    engine.createCoder!(creds, 'kimi-k2-thinking');
    const b = chatCalls[1];
    expect(b).toEqual(a);
    expect(b.model).toBe('kimi-k2-thinking');
    expect(b.baseURL).toBe('https://api.kimi.com/coding/v1'); // spec.defaultBaseURL
    expect(b.thinkingMode).toBe('auto'); // unknown/missing → fallback
  });

  it('createCoder coerces an illegal thinkingMode to auto (both)', () => {
    const creds: ResolvedCreds = { apiKey: 'k', extra: { thinkingMode: 'garbage' } };
    kimiCode.createCoder!(creds, undefined);
    const a = chatCalls[0];
    engine.createCoder!(creds, undefined);
    const b = chatCalls[1];
    expect(b).toEqual(a);
    expect(b.thinkingMode).toBe('auto');
  });

  it('createIndexer builds an identical adapter', () => {
    kimiCode.createIndexer!(CREDS, undefined);
    const a = idxCalls[0];
    engine.createIndexer!(CREDS, undefined);
    const b = idxCalls[1];
    expect(b.cls).toBe(a.cls);
    expect(stripTrailingUndefined(b.args)).toEqual(stripTrailingUndefined(a.args));
  });

  it('createIndexer honors an explicit model + baseURL/default fallback', () => {
    const creds: ResolvedCreds = { apiKey: 'k' };
    kimiCode.createIndexer!(creds, 'kimi-k2.5');
    const a = idxCalls[0];
    engine.createIndexer!(creds, 'kimi-k2.5');
    const b = idxCalls[1];
    expect(stripTrailingUndefined(b.args)).toEqual(stripTrailingUndefined(a.args));
    // positional: (apiKey, model, baseURL, headers)
    expect(b.args[1]).toBe('kimi-k2.5');
    expect(b.args[2]).toBe('https://api.kimi.com/coding/v1');
  });
});
