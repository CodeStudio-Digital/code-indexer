import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ResolvedCreds, ProviderConfigLike, ProviderDefinition } from '@mcp/provider-sdk';

const fetchCalls: Array<{ url: string; init: unknown }> = [];
const ccModelsCalls: unknown[] = [];
const kimiModelsCalls: unknown[] = [];

// Break the store→registry cycle; the happy-path checks never hit the store.
vi.mock('@mcp/services/providers/shared/store.js', () => ({ getStore: () => null }));
// Keep the real modules (the claude-code wire needs resolveClaudeCodeModel) but
// spy the network fns both the definition AND the engine call.
vi.mock('@mcp/services/services/oauth/claude-code.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchClaudeCodeModels: vi.fn(async (input: unknown) => {
    ccModelsCalls.push(input);
    return [];
  }),
}));
vi.mock('@mcp/services/services/oauth/kimi-code.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchKimiCodeModels: vi.fn(async (opts: unknown) => {
    kimiModelsCalls.push(opts);
    return [];
  }),
}));

import { copilot } from '@mcp/services/providers/definitions/copilot.js';
import { googleOAuth } from '@mcp/services/providers/definitions/google-oauth.js';
import { chatgpt } from '@mcp/services/providers/definitions/chatgpt.js';
import { claudeCode } from '@mcp/services/providers/definitions/claude-code.js';
import { kimiCode } from '@mcp/services/providers/definitions/kimi-code.js';
import { buildProviderDefinition } from '../build-definition.js';
import { copilotSpec } from '../specs/copilot.js';
import { googleOAuthSpec } from '../specs/google-oauth.js';
import { chatgptSpec } from '../specs/chatgpt.js';
import { claudeCodeSpec } from '../specs/claude-code.js';
import { kimiCodeSpec } from '../specs/kimi.js';

const origFetch = globalThis.fetch;
const config: ProviderConfigLike = { id: 'p1', kind: 'k', base_url: null };

beforeEach(() => {
  fetchCalls.length = ccModelsCalls.length = kimiModelsCalls.length = 0;
  globalThis.fetch = vi.fn(async (url: unknown, init?: unknown) => {
    fetchCalls.push({ url: String(url), init });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

type Def = { testConnection?: ProviderDefinition['testConnection'] };

async function runBoth(def: Def, spec: Parameters<typeof buildProviderDefinition>[0], creds: ResolvedCreds) {
  const snap = () => ({ fetch: [...fetchCalls], cc: [...ccModelsCalls], kimi: [...kimiModelsCalls] });
  const reset = () => {
    fetchCalls.length = ccModelsCalls.length = kimiModelsCalls.length = 0;
  };

  reset();
  await def.testConnection!({ config, creds });
  const a = snap();

  reset();
  const engine = buildProviderDefinition(spec);
  expect(engine.testConnection, 'engine must produce a REAL check, not a no-op').toBeTypeOf('function');
  await engine.testConnection!({ config, creds });
  const b = snap();

  expect(b).toEqual(a);
  return b;
}

describe('OAuth testConnection equivalence: engine(spec) == definition (closes the CI blind spot)', () => {
  it('copilot (openai-models): pings {base}/models with Bearer + editor headers', async () => {
    const creds: ResolvedCreds = {
      apiKey: 'tok',
      baseURL: 'https://api.githubcopilot.com',
      extraHeaders: { 'Editor-Version': 'x', 'Copilot-Integration-Id': 'y' },
    };
    const b = await runBoth(copilot, copilotSpec, creds);
    expect(b.fetch[0].url).toBe('https://api.githubcopilot.com/models');
  });

  it('google-oauth (gemini-oauth): pings generativelanguage with Bearer', async () => {
    const creds: ResolvedCreds = { apiKey: 'access-tok' };
    const b = await runBoth(googleOAuth, googleOAuthSpec, creds);
    expect(b.fetch[0].url).toContain('generativelanguage.googleapis.com');
  });

  it('chatgpt (codex-health): pings {base}/health, no throw on 200', async () => {
    const creds: ResolvedCreds = { apiKey: 'tok', extra: { accountId: 'a' } };
    const b = await runBoth(chatgpt, chatgptSpec, creds);
    expect(b.fetch[0].url).toBe('https://chatgpt.com/backend-api/codex/health');
  });

  it('chatgpt (codex-health): both throw the same "no access token" when apiKey missing', async () => {
    const creds: ResolvedCreds = {};
    await expect(chatgpt.testConnection!({ config, creds })).rejects.toThrow('no access token stored');
    await expect(buildProviderDefinition(chatgptSpec).testConnection!({ config, creds })).rejects.toThrow(
      'no access token stored',
    );
  });

  it('claude-code (sdk:claude-code): both call fetchClaudeCodeModels with identical input', async () => {
    const creds: ResolvedCreds = {
      authToken: 'bearer',
      baseURL: 'https://api.anthropic.com',
      extraHeaders: { 'x-h': '1' },
    };
    const b = await runBoth(claudeCode, claudeCodeSpec, creds);
    expect(b.cc).toHaveLength(1);
  });

  it('kimi-code (sdk:kimi-code): both call fetchKimiCodeModels with identical input', async () => {
    const creds: ResolvedCreds = { apiKey: 'k', baseURL: 'https://api.kimi.com/coding/v1', extraHeaders: { a: 'b' } };
    const b = await runBoth(kimiCode, kimiCodeSpec, creds);
    expect(b.kimi).toHaveLength(1);
  });
});
