import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedCreds } from '@mcp/provider-sdk';

const coderCalls: Array<Record<string, unknown>> = [];
const idxCalls: Array<unknown[]> = [];
let storeRows: Array<Record<string, unknown>> | null = null;

vi.mock('@mcp/code-agent/providers/anthropic.js', () => ({
  AnthropicChatProvider: vi.fn().mockImplementation(function (opts: Record<string, unknown>) {
    coderCalls.push(opts);
  }),
}));
vi.mock('@mcp/indexer/indexer/providers/anthropic.js', () => ({
  AnthropicProvider: vi.fn().mockImplementation(function (...args: unknown[]) {
    idxCalls.push(args);
  }),
}));
// Break the store→seed→registry cycle and control the effort override lookup.
vi.mock('@mcp/services/providers/shared/store.js', () => ({
  getStore: () => (storeRows == null ? null : { listModels: () => storeRows }),
}));

// resolveClaudeCodeModel + getClaudeCodeSystemPrefixBlocks are NOT mocked — both
// the definition and the engine call the same real functions, so identical inputs
// must yield identical adapter config. That's the equivalence we're proving.
import { claudeCode } from '@mcp/services/providers/definitions/claude-code.js';
import { buildProviderDefinition } from '../build-definition.js';
import { claudeCodeSpec } from '../specs/claude-code.js';

/** Compare two AnthropicChatProvider option objects, invoking the resolveModel closure. */
function compareCoder(a: Record<string, unknown>, b: Record<string, unknown>) {
  const { resolveModel: ra, fetch: fa, ...restA } = a;
  const { resolveModel: rb, fetch: fb, ...restB } = b;
  expect(restB).toEqual(restA);
  expect(fb).toBe(fa);
  const rfa = ra as (m: string, req: unknown) => unknown;
  const rfb = rb as (m: string, req: unknown) => unknown;
  for (const [sel, req] of [
    ['opus', { tools: [{ name: 't' }] }],
    ['sonnet', { tools: [] }],
    ['haiku', {}],
    ['default', { tools: [{ name: 'a' }, { name: 'b' }] }],
    ['opus-4-6', { tools: [] }],
  ] as const) {
    expect(rfb(sel, req)).toEqual(rfa(sel, req));
  }
}

describe('claude-code equivalence: engine(spec) == definition', () => {
  beforeEach(() => {
    coderCalls.length = 0;
    idxCalls.length = 0;
    storeRows = null;
  });

  it('metadata matches', () => {
    const built = buildProviderDefinition(claudeCodeSpec);
    expect(built.kind).toBe(claudeCode.kind);
    expect(built.displayName).toBe(claudeCode.displayName);
    expect(built.credKind).toBe('oauth');
    expect(built.defaultBaseURL).toBe(claudeCode.defaultBaseURL);
    expect(built.defaultModel).toBe(claudeCode.defaultModel);
    expect(built.defaultModels).toEqual(claudeCode.defaultModels);
    expect(built.pricing).toEqual(claudeCode.pricing);
    expect(built.capabilities).toEqual(claudeCode.capabilities);
    expect(built.visual).toEqual(claudeCode.visual);
  });

  it('createCoder (OAuth bearer): adaptive resolver + system blocks identical', () => {
    const creds: ResolvedCreds = {
      authToken: 'oauth-bearer',
      baseURL: 'https://api.anthropic.com',
      extraHeaders: { 'anthropic-beta': 'should-be-stripped', 'x-keep': 'yes' },
      extra: { metadata: { user_id: 'u1' }, subscriptionType: 'max', rateLimitTier: 'tier-5' },
    };
    claudeCode.createCoder!(creds, undefined, { providerId: '5' });
    buildProviderDefinition(claudeCodeSpec).createCoder!(creds, undefined, { providerId: '5' });
    compareCoder(coderCalls[0], coderCalls[1]);
    // anthropic-beta stripped from headers, x-keep retained
    expect((coderCalls[1].defaultHeaders as Record<string, string>)['anthropic-beta']).toBeUndefined();
    expect((coderCalls[1].defaultHeaders as Record<string, string>)['x-keep']).toBe('yes');
  });

  it('createCoder (console api-key, no authToken): no system prefix blocks', () => {
    const creds: ResolvedCreds = {
      apiKey: 'managed-key',
      extra: { profile_info: { subscriptionType: 'pro', rateLimitTier: null } },
    };
    claudeCode.createCoder!(creds, 'opus', { providerId: undefined });
    buildProviderDefinition(claudeCodeSpec).createCoder!(creds, 'opus', { providerId: undefined });
    compareCoder(coderCalls[0], coderCalls[1]);
    expect(coderCalls[1].systemPrefixBlocks).toBeUndefined();
  });

  it('createCoder: per-model effort override from provider_models flows identically', () => {
    storeRows = [{ model_id: 'opus', default_reasoning_level: 'high' }];
    const creds: ResolvedCreds = { authToken: 'bearer', extra: { subscriptionType: 'max' } };
    claudeCode.createCoder!(creds, 'opus', { providerId: '9' });
    buildProviderDefinition(claudeCodeSpec).createCoder!(creds, 'opus', { providerId: '9' });
    compareCoder(coderCalls[0], coderCalls[1]);
  });

  it('createIndexer builds an identical adapter (bearer + api-key)', () => {
    for (const creds of [
      { authToken: 'bearer', extra: { subscriptionType: 'max' } } as ResolvedCreds,
      { apiKey: 'managed', extra: {} } as ResolvedCreds,
    ]) {
      idxCalls.length = 0;
      claudeCode.createIndexer!(creds, 'haiku');
      buildProviderDefinition(claudeCodeSpec).createIndexer!(creds, 'haiku');
      expect(idxCalls[1]).toEqual(idxCalls[0]);
    }
  });
});
