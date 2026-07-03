import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ProviderConfig, ProviderStore } from '@mcp/store/provider-store.js';

// Mock the two I/O boundaries:
//  - `resolveClaudeCodeCreds` (shared/oauth) avoids the real `getStore()`
//    requirement and lets us pin the resolved creds deterministically.
//  - `fetchClaudeCodeModels` (services/oauth/claude-code) is the live HTTP call;
//    we toggle it between a live list and a throw to exercise both branches.
// `resolveClaudeCodeModel` is kept real (pure, deterministic, no I/O).
const mockResolveCreds = vi.fn();
const mockFetchModels = vi.fn();

vi.mock('@mcp/services/providers/shared/oauth.js', () => ({
  resolveClaudeCodeCreds: (...args: unknown[]) => mockResolveCreds(...args),
}));

vi.mock('@mcp/services/services/oauth/claude-code.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@mcp/services/services/oauth/claude-code.js')
  >();
  return {
    ...actual,
    fetchClaudeCodeModels: (...args: unknown[]) => mockFetchModels(...args),
  };
});

import { discoverClaudeCodeModels } from '../discovery/claude-code-models.js';
import { claudeCodeSpec } from '../specs/claude-code.js';

const CFG = { id: 1, base_url: null, api_key: null } as unknown as ProviderConfig;

// The engine builder takes `store` for uniformity but never touches it (creds
// come from the mocked resolver). A bare object is sufficient.
const STORE = {} as unknown as ProviderStore;

// Bearer/OAuth creds — `authToken` set so `includeOAuth: !!creds.authToken` is
// true, matching a real Claude.ai inference connection.
const RESOLVED_CREDS = {
  baseURL: 'https://api.anthropic.com',
  apiKey: undefined,
  authToken: 'oauth-bearer',
  extraHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
  fetch: globalThis.fetch,
  extra: { subscriptionType: 'max', rateLimitTier: null },
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('sdk:claude-code discovery', () => {
  it('merges live model annotations with the seed catalog', async () => {
    // A representative live list. The seed resolves to apiModels not all present
    // here, so the ` Not returned by live ...` note fires for some rows and not
    // others — pinning both sides of the `liveNote` ternary.
    const liveList = [
      { id: 'claude-sonnet-4-6' },
      { id: 'claude-opus-4-7' },
    ];

    mockResolveCreds.mockResolvedValue(RESOLVED_CREDS);
    mockFetchModels.mockResolvedValue(liveList);
    const b = await discoverClaudeCodeModels(claudeCodeSpec, CFG, STORE);

    expect(b).toHaveLength(8);
    expect(b.every((m) => m.source === 'live')).toBe(true);
    expect(b.every((m) => /Resolved: .+ -> .+\. Betas:/.test(m.description ?? ''))).toBe(true);
  });

  it('fetch failure still emits seed-only catalog without liveNote', async () => {
    mockResolveCreds.mockResolvedValue(RESOLVED_CREDS);
    mockFetchModels.mockRejectedValue(new Error('network down'));
    const b = await discoverClaudeCodeModels(claudeCodeSpec, CFG, STORE);

    expect(b).toHaveLength(8);
    expect(b.some((m) => (m.description ?? '').includes('Not returned by live'))).toBe(false);
  });
});
