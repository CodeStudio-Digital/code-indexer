/**
 * Tests for the unified provider registry and its definitions.
 *
 * Strategy: mock the adapter constructors (OpenAIChatProvider, GeminiChatProvider)
 * so tests can capture the exact arguments they receive. The real adapters
 * construct SDK clients that would otherwise hit the network.
 *
 * Scope:
 *   - parseModelWithMode pure helper
 *   - Z.AI definition: base URL switching based on `::coding` mode
 *   - Google OAuth definition: cloudCodeSessionId propagation
 *   - Copilot/ChatGPT/Google resolve*Creds: api_key mirror writeback on refresh
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────
// Record constructor args so definition-level tests can inspect them.
const openAICalls: Array<Record<string, unknown>> = [];
const geminiCalls: Array<Record<string, unknown>> = [];

vi.mock('@mcp/code-agent/providers/openai.js', () => ({
  OpenAIChatProvider: vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
    opts: Record<string, unknown>,
  ) {
    openAICalls.push(opts);
    Object.assign(this, opts, { name: (opts.name as string) ?? 'openai' });
  }),
}));

vi.mock('@mcp/code-agent/providers/gemini.js', () => ({
  GeminiChatProvider: vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
    opts: Record<string, unknown>,
  ) {
    geminiCalls.push(opts);
    Object.assign(this, opts, { name: 'gemini' });
  }),
}));

// Mock OAuth refresh endpoints so tests never hit the network.
vi.mock('@mcp/services/services/oauth/copilot.js', () => ({
  refreshIfExpired: vi.fn().mockResolvedValue('fresh-copilot-token'),
  copilotHeaders: () => ({ 'Editor-Version': 'vscode/1.0' }),
  getStoredCopilotOpts: () => ({ edition: 'individual' }),
}));
vi.mock('@mcp/services/services/oauth/openai.js', () => ({
  refreshIfExpired: vi.fn().mockResolvedValue('fresh-chatgpt-token'),
  CHATGPT_CODEX_BASE_URL: 'https://chatgpt.com/backend-api/codex',
}));
vi.mock('@mcp/services/services/oauth/google.js', () => ({
  refreshIfExpired: vi.fn().mockResolvedValue('fresh-google-token'),
}));
vi.mock('@mcp/code-agent/providers/chatgpt.js', async () => {
  const actual = await vi.importActual<typeof import('@mcp/code-agent/providers/chatgpt.js')>(
    '@mcp/code-agent/providers/chatgpt.js',
  );
  return { ...actual, extractAccountIdFromIdToken: () => 'acct-123' };
});

import type { ProviderConfig, ProviderStore } from '@mcp/store/provider-store.js';
import type { ResolvedCreds } from '@mcp/services/providers/types.js';
import { parseModelWithMode } from '@mcp/services/providers/shared/model-mode.js';
import { buildProviderDefinition } from '@mcp/provider-engine/build-definition.js';
import { zaiSpec } from '@mcp/provider-engine/specs/openai-compat.js';
import { googleOAuthSpec } from '@mcp/provider-engine/specs/google-oauth.js';
import { kimiCodeSpec } from '@mcp/provider-engine/specs/kimi.js';

const zai = buildProviderDefinition(zaiSpec);
const googleOAuth = buildProviderDefinition(googleOAuthSpec);

beforeEach(() => {
  openAICalls.length = 0;
  geminiCalls.length = 0;
});

// ─── parseModelWithMode ──────────────────────────────────────────────────
describe('parseModelWithMode', () => {
  it('returns undefined for empty and nullish input', () => {
    expect(parseModelWithMode(undefined)).toEqual({ model: undefined, mode: undefined });
    expect(parseModelWithMode('')).toEqual({ model: undefined, mode: undefined });
  });

  it('returns model only when no :: separator is present', () => {
    expect(parseModelWithMode('glm-5.1')).toEqual({ model: 'glm-5.1', mode: undefined });
    expect(parseModelWithMode('gpt-4o-mini')).toEqual({ model: 'gpt-4o-mini', mode: undefined });
  });

  it('splits model and mode when :: is present', () => {
    expect(parseModelWithMode('glm-5.1::coding')).toEqual({ model: 'glm-5.1', mode: 'coding' });
    expect(parseModelWithMode('glm-4::general')).toEqual({ model: 'glm-4', mode: 'general' });
  });

  it('leaves undefined halves when either side is empty', () => {
    expect(parseModelWithMode('::coding')).toEqual({ model: undefined, mode: 'coding' });
    expect(parseModelWithMode('glm-5.1::')).toEqual({ model: 'glm-5.1', mode: undefined });
  });
});

// ─── Z.AI definition: createCoder URL switching ─────────────────────────
describe('zai.createCoder — URL switching', () => {
  const creds: ResolvedCreds = { apiKey: 'test-key' };
  const origBaseURL = process.env.ZAI_BASE_URL;
  beforeEach(() => { delete process.env.ZAI_BASE_URL; });
  afterEach(() => {
    if (origBaseURL !== undefined) process.env.ZAI_BASE_URL = origBaseURL;
    else delete process.env.ZAI_BASE_URL;
  });

  it('routes glm-5.1 (no mode) to the general URL (coding is opt-in only)', () => {
    zai.createCoder!(creds, 'glm-5.1');
    expect(openAICalls[0].baseURL).toBe('https://api.z.ai/api/paas/v4/');
  });

  it('routes glm-4-air (no mode, not in coding set) to the general URL', () => {
    zai.createCoder!(creds, 'glm-4-air');
    expect(openAICalls[0].baseURL).toBe('https://api.z.ai/api/paas/v4/');
  });

  it('routes "glm-4-air::coding" to the coding URL (explicit mode wins)', () => {
    zai.createCoder!(creds, 'glm-4-air::coding');
    expect(openAICalls[0].baseURL).toBe('https://api.z.ai/api/coding/paas/v4/');
  });

  it('routes "glm-5.1::general" to the general URL (explicit mode wins)', () => {
    zai.createCoder!(creds, 'glm-5.1::general');
    expect(openAICalls[0].baseURL).toBe('https://api.z.ai/api/paas/v4/');
  });

  it('routes "glm-5.1::coding" to the coding URL, overriding creds.baseURL (explicit opt-in wins)', () => {
    // Coding is now opt-in only: an explicit `::coding` suffix is the single
    // way to reach the coding endpoint, and it beats a cfg.base_url pointing
    // at the general URL so opt-in sessions are never silently downgraded.
    zai.createCoder!({ ...creds, baseURL: 'https://api.z.ai/api/paas/v4' }, 'glm-5.1::coding');
    expect(openAICalls[0].baseURL).toBe('https://api.z.ai/api/coding/paas/v4/');
  });

  it('honors ZAI_BASE_URL env var over everything', () => {
    process.env.ZAI_BASE_URL = 'https://env-override.example/v1';
    zai.createCoder!(creds, 'glm-5.1');
    expect(openAICalls[0].baseURL).toBe('https://env-override.example/v1');
  });

  it('strips the "::mode" suffix from the model passed to the adapter', () => {
    zai.createCoder!(creds, 'glm-5.1::coding');
    expect(openAICalls[0].model).toBe('glm-5.1');
  });

  it('picks default model glm-5.1 when model is undefined', () => {
    zai.createCoder!(creds, undefined);
    expect(openAICalls[0].model).toBe('glm-5.1');
  });
});

// ─── lookupProvider — ZAI masquerade rewrite ────────────────────────────
describe('lookupProvider — CodeStudio Local formats', () => {
  const origBaseURL = process.env.ZAI_BASE_URL;
  beforeEach(() => { delete process.env.ZAI_BASE_URL; });
  afterEach(() => {
    if (origBaseURL !== undefined) process.env.ZAI_BASE_URL = origBaseURL;
    else delete process.env.ZAI_BASE_URL;
  });

  it('rejects retired Z.AI rows stored as OpenAI', async () => {
    const store = {
      getProvider: (): ProviderConfig => ({
        id: 'zai',
        name: 'Z.AI',
        kind: 'openai', // legacy shape
        base_url: 'https://api.z.ai/api/paas/v4',
        api_key: 'ztoken',
        auth_mode: 'api_key',
        enabled: true,
        use_for_agent: true,
        use_for_coder: true,
        use_for_general: false,
        is_default: false,
        extra: {},
        fallback_provider_id: null,
        created_at: '',
        updated_at: '',
      }),
      listProviders: () => [],
    } as unknown as ProviderStore;

    const { lookupProvider } = await import('@mcp/services/providers/factory.js');
    await withMockedStore(store, async () => {
      await expect(lookupProvider('zai')).rejects.toThrow('unavailable in CodeStudio Local');
    });
  });

  it('rejects renamed legacy Z.AI coding rows', async () => {
    const store = {
      getProvider: (): ProviderConfig => ({
        id: 'my-zai',
        name: 'Custom Z.AI',
        kind: 'openai',
        base_url: 'https://api.z.ai/api/paas/v4',
        api_key: 'ztoken',
        auth_mode: 'api_key',
        enabled: true,
        use_for_agent: true,
        use_for_coder: true,
        use_for_general: false,
        is_default: false,
        extra: { zai_has_coding_mode: true },
        fallback_provider_id: null,
        created_at: '',
        updated_at: '',
      }),
      listProviders: () => [],
    } as unknown as ProviderStore;

    const { lookupProvider } = await import('@mcp/services/providers/factory.js');
    await withMockedStore(store, async () => {
      await expect(lookupProvider('my-zai')).rejects.toThrow('unavailable in CodeStudio Local');
    });
  });

  it('leaves a genuine openai provider alone (id != "zai", no zai flag)', async () => {
    const store = {
      getProvider: (): ProviderConfig => ({
        id: 'openai',
        name: 'OpenAI',
        kind: 'openai',
        base_url: null,
        api_key: 'sk-real',
        auth_mode: 'api_key',
        enabled: true,
        use_for_agent: true,
        use_for_coder: true,
        use_for_general: false,
        is_default: false,
        extra: {},
        fallback_provider_id: null,
        created_at: '',
        updated_at: '',
      }),
      listProviders: () => [],
    } as unknown as ProviderStore;

    const { lookupProvider } = await import('@mcp/services/providers/factory.js');
    await withMockedStore(store, async () => {
      const { def } = await lookupProvider('openai');
      expect(def.kind).toBe('openai');
    });
  });

  it('rejects retired Kimi Code rows stored as OpenAI', async () => {
    const store = {
      getProvider: (): ProviderConfig => ({
        id: 'kimi-code',
        name: 'Kimi',
        kind: 'openai',
        base_url: 'https://api.kimi.com/coding/v1',
        api_key: 'kimi-token',
        auth_mode: 'oauth',
        enabled: true,
        use_for_agent: true,
        use_for_coder: true,
        use_for_general: false,
        is_default: false,
        extra: { oauth_key: 'oauth/kimi-code' },
        fallback_provider_id: null,
        created_at: '',
        updated_at: '',
      }),
      listProviders: () => [],
    } as unknown as ProviderStore;

    const { lookupProvider } = await import('@mcp/services/providers/factory.js');
    await withMockedStore(store, async () => {
      await expect(lookupProvider('kimi-code')).rejects.toThrow('unavailable in CodeStudio Local');
    });
  });
});

// ─── No env credential fallback ─────────────────────────────────────────
/**
 * Credentials never come from the environment — the provider configuration is
 * the sole source. An env var like ZAI_API_KEY must not resolve to a key, nor
 * auto-select a provider when nothing is configured.
 */
describe('resolveCreds — env vars are not a credential source', () => {
  const orig = process.env.ZAI_API_KEY;
  beforeEach(() => { process.env.ZAI_API_KEY = 'env-token-should-be-ignored'; });
  afterEach(() => {
    if (orig !== undefined) process.env.ZAI_API_KEY = orig;
    else delete process.env.ZAI_API_KEY;
  });

  it('returns apiKey undefined for an api-key shape with no DB row, even with the env var set', async () => {
    const { resolveCreds } = await import('@mcp/services/providers/shared/resolver.js');
    const creds = await resolveCreds(zai, null);
    expect(creds.apiKey).toBeUndefined();
    expect(creds.baseURL).toBe('https://api.z.ai/api/paas/v4'); // def.defaultBaseURL
  });

  it('uses the configured DB key when a row is present', async () => {
    const { resolveCreds } = await import('@mcp/services/providers/shared/resolver.js');
    const cfg = {
      id: 'zai', name: 'Z.AI', kind: 'zai', base_url: null, api_key: 'db-key',
      auth_mode: 'api_key', enabled: true, use_for_agent: true, use_for_coder: true,
      use_for_general: false, is_default: false, extra: {}, fallback_provider_id: null,
      created_at: '', updated_at: '',
    } as ProviderConfig;
    const creds = await resolveCreds(zai, cfg);
    expect(creds.apiKey).toBe('db-key');
  });
});

describe('lookupProvider — no env auto-select', () => {
  const orig = process.env.ZAI_API_KEY;
  beforeEach(() => { process.env.ZAI_API_KEY = 'env-token-should-be-ignored'; });
  afterEach(() => {
    if (orig !== undefined) process.env.ZAI_API_KEY = orig;
    else delete process.env.ZAI_API_KEY;
  });

  it('throws when nothing is configured, even though an env var is set', async () => {
    const store = {
      getProvider: () => null,
      listProviders: () => [],
    } as unknown as ProviderStore;

    const { lookupProvider } = await import('@mcp/services/providers/factory.js');
    await withMockedStore(store, async () => {
      await expect(lookupProvider()).rejects.toThrow(/No provider available/);
    });
  });
});

// ─── Google OAuth definition: cloudCodeSessionId propagation ─────────────
describe('google-oauth.createCoder — cloudCodeSessionId', () => {
  const creds: ResolvedCreds = {
    apiKey: 'access-token',
    extra: { refreshToken: 'rtoken', projectId: 'proj-123' },
  };

  it('forwards cloudCodeSessionId into the GeminiChatProvider', () => {
    googleOAuth.createCoder!(creds, 'gemini-2.5-pro', { cloudCodeSessionId: 'session-abc' });
    expect(geminiCalls[0].cloudCodeSessionId).toBe('session-abc');
  });

  it('works without opts (backwards compat)', () => {
    googleOAuth.createCoder!(creds, 'gemini-2.5-pro');
    expect(geminiCalls[0].cloudCodeSessionId).toBeUndefined();
  });

  it('exposes refreshToken and projectId from creds.extra', () => {
    googleOAuth.createCoder!(creds, 'gemini-2.5-pro');
    expect(geminiCalls[0].refreshToken).toBe('rtoken');
    expect(geminiCalls[0].projectId).toBe('proj-123');
    expect(geminiCalls[0].accessToken).toBe('access-token');
  });
});

// ─── resolve*Creds — api_key mirror writeback ────────────────────────────
/**
 * Minimal in-memory fake of ProviderStore — implements only the methods
 * exercised by resolve*Creds. Tracks upsertProvider calls so tests can
 * assert the api_key mirror was refreshed.
 */
function fakeStore(): {
  store: Pick<ProviderStore, 'getOAuth' | 'upsertProvider'>;
  upsertCalls: Array<Partial<ProviderConfig>>;
} {
  const upsertCalls: Array<Partial<ProviderConfig>> = [];
  const store = {
    getOAuth: () => ({
      provider_id: 'test',
      access_token: 'fresh-copilot-token',
      refresh_token: 'rt',
      expires_at: Date.now() + 60_000,
      scope: null,
      extra: { id_token: 'jwt-here', projectId: 'proj-1' },
      updated_at: new Date().toISOString(),
    }),
    upsertProvider: (cfg: ProviderConfig) => { upsertCalls.push({ ...cfg }); return cfg; },
  } as unknown as Pick<ProviderStore, 'getOAuth' | 'upsertProvider'>;
  return { store, upsertCalls };
}

async function withMockedStore(
  store: Pick<ProviderStore, 'getOAuth' | 'upsertProvider'>,
  fn: () => Promise<void>,
): Promise<void> {
  const shared = await import('@mcp/services/providers/shared/store.js');
  shared.__setStoreForTests(store as unknown as ProviderStore);
  try {
    await fn();
  } finally {
    shared.__setStoreForTests(null);
  }
}

const baseCfg: ProviderConfig = {
  id: 'copilot-inst',
  name: 'copilot',
  kind: 'copilot',
  base_url: null,
  api_key: 'stale-token',
  auth_mode: 'oauth',
  enabled: true,
  use_for_agent: true,
  use_for_coder: true,
  use_for_general: false,
  is_default: false,
  extra: {},
  fallback_provider_id: null,
  created_at: '',
  updated_at: '',
};

describe('resolveCopilotCreds — api_key mirror writeback', () => {
  it('writes the fresh token back to providers.api_key when it changed', async () => {
    const { store, upsertCalls } = fakeStore();
    const { resolveCopilotCreds } = await import('@mcp/services/providers/shared/oauth.js');
    await withMockedStore(store, async () => {
      const creds = await resolveCopilotCreds({ ...baseCfg, api_key: 'stale-token' });
      expect(creds.apiKey).toBe('fresh-copilot-token');
      expect(upsertCalls).toHaveLength(1);
      expect(upsertCalls[0].api_key).toBe('fresh-copilot-token');
    });
  });

  it('does not write back when the refresh returned the same token', async () => {
    const { store, upsertCalls } = fakeStore();
    const { resolveCopilotCreds } = await import('@mcp/services/providers/shared/oauth.js');
    await withMockedStore(store, async () => {
      const creds = await resolveCopilotCreds({ ...baseCfg, api_key: 'fresh-copilot-token' });
      expect(creds.apiKey).toBe('fresh-copilot-token');
      expect(upsertCalls).toHaveLength(0);
    });
  });
});

describe('resolveChatGPTCreds — api_key mirror writeback', () => {
  it('writes the fresh token back to providers.api_key when it changed', async () => {
    const { store, upsertCalls } = fakeStore();
    const { resolveChatGPTCreds } = await import('@mcp/services/providers/shared/oauth.js');
    await withMockedStore(store, async () => {
      const cfg: ProviderConfig = { ...baseCfg, kind: 'chatgpt', api_key: 'stale-token' };
      const creds = await resolveChatGPTCreds(cfg);
      expect(creds.apiKey).toBe('fresh-chatgpt-token');
      expect(upsertCalls).toHaveLength(1);
      expect(upsertCalls[0].api_key).toBe('fresh-chatgpt-token');
    });
  });

  it('also surfaces the extracted accountId', async () => {
    const { store } = fakeStore();
    const { resolveChatGPTCreds } = await import('@mcp/services/providers/shared/oauth.js');
    await withMockedStore(store, async () => {
      const cfg: ProviderConfig = { ...baseCfg, kind: 'chatgpt', api_key: 'stale-token' };
      const creds = await resolveChatGPTCreds(cfg);
      expect(creds.extra?.accountId).toBe('acct-123');
    });
  });
});

describe('resolveGoogleOAuthCreds — api_key mirror writeback', () => {
  it('writes the fresh token back to providers.api_key when it changed', async () => {
    const { store, upsertCalls } = fakeStore();
    const { resolveGoogleOAuthCreds } = await import('@mcp/services/providers/shared/oauth.js');
    await withMockedStore(store, async () => {
      const cfg: ProviderConfig = { ...baseCfg, kind: 'google-oauth', api_key: 'stale-token' };
      const creds = await resolveGoogleOAuthCreds(cfg);
      expect(creds.apiKey).toBe('fresh-google-token');
      expect(upsertCalls).toHaveLength(1);
      expect(upsertCalls[0].api_key).toBe('fresh-google-token');
    });
  });

  it('exposes refreshToken and projectId from oauth_tokens row', async () => {
    const { store } = fakeStore();
    const { resolveGoogleOAuthCreds } = await import('@mcp/services/providers/shared/oauth.js');
    await withMockedStore(store, async () => {
      const cfg: ProviderConfig = { ...baseCfg, kind: 'google-oauth', api_key: 'stale-token' };
      const creds = await resolveGoogleOAuthCreds(cfg);
      expect(creds.extra?.refreshToken).toBe('rt');
      expect(creds.extra?.projectId).toBe('proj-1');
    });
  });
});

describe('Kimi Code API-key credential resolution', () => {
  it('uses the user API token directly and has no OAuth descriptor', async () => {
    const def = buildProviderDefinition(kimiCodeSpec);
    const { resolveCreds } = await import('@mcp/services/providers/shared/resolver.js');
    const cfg: ProviderConfig = {
      ...baseCfg,
      id: 'kimi-code',
      kind: 'kimi-code',
      base_url: 'https://api.kimi.com/coding/v1',
      api_key: 'user-api-token',
      auth_mode: 'api_key',
      extra: { thinkingMode: 'disabled' },
    };

    await expect(resolveCreds(def, cfg)).resolves.toMatchObject({
      apiKey: 'user-api-token',
      baseURL: 'https://api.kimi.com/coding/v1',
      extra: { thinkingMode: 'disabled' },
    });
    expect(def.auth).toBeUndefined();
  });
});
