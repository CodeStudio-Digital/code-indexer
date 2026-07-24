import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderStore, OAuthTokenRow } from '@mcp/store/provider-store.js';
import {
  __setClaudeCodeFetchForTests,
  buildClaudeCodeAuthUrl,
  buildClaudeCodeModelsUrl,
  buildClaudeCodeRefreshRequest,
  buildClaudeCodeTokenExchangeRequest,
  CLAUDE_CODE_PACKAGE_VERSION,
  claudeCodeAuthHeaders,
  createClaudeCodeFetchWithRetry,
  getClaudeCodeBetasForModel,
  parseClaudeCodeRateLimitHeaders,
  refreshIfExpired,
  resolveClaudeCodeModel,
} from '@mcp/services/services/oauth/claude-code.js';

afterEach(() => {
  __setClaudeCodeFetchForTests(null);
});

describe('Claude Code OAuth parity helpers', () => {
  it('builds the Claude.ai authorize URL with official params and scopes', () => {
    const url = new URL(buildClaudeCodeAuthUrl({
      codeChallenge: 'challenge',
      state: 'state-123',
      port: 1456,
      loginWithClaudeAi: true,
      loginHint: 'user@example.com',
      loginMethod: 'browser',
      orgUUID: 'org-1',
    }));

    expect(url.origin + url.pathname).toBe('https://claude.com/cai/oauth/authorize');
    expect(url.searchParams.get('code')).toBe('true');
    expect(url.searchParams.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1456/callback');
    expect(url.searchParams.get('scope')).toBe(
      'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
    );
    expect(url.searchParams.get('code_challenge')).toBe('challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('orgUUID')).toBe('org-1');
    expect(url.searchParams.get('login_hint')).toBe('user@example.com');
    expect(url.searchParams.get('login_method')).toBe('browser');

    const manualUrl = new URL(buildClaudeCodeAuthUrl({
      codeChallenge: 'challenge',
      state: 'state-123',
      port: 1456,
      isManual: true,
      loginWithClaudeAi: true,
    }));
    expect(manualUrl.searchParams.get('redirect_uri')).toBe(
      'https://platform.claude.com/oauth/code/callback',
    );
  });

  it('builds the official token exchange and refresh bodies', () => {
    expect(buildClaudeCodeTokenExchangeRequest({
      code: 'code',
      state: 'state',
      codeVerifier: 'verifier',
      port: 1456,
    })).toEqual({
      url: 'https://platform.claude.com/v1/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: {
        grant_type: 'authorization_code',
        code: 'code',
        redirect_uri: 'http://localhost:1456/callback',
        client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
        code_verifier: 'verifier',
        state: 'state',
      },
    });

    expect(buildClaudeCodeTokenExchangeRequest({
      code: 'code',
      state: 'state',
      codeVerifier: 'verifier',
      port: 1456,
      isManual: true,
    }).body?.redirect_uri).toBe('https://platform.claude.com/oauth/code/callback');

    expect(buildClaudeCodeRefreshRequest({ refreshToken: 'refresh' })).toEqual({
      url: 'https://platform.claude.com/v1/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: {
        grant_type: 'refresh_token',
        refresh_token: 'refresh',
        client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
        scope: 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
      },
    });
  });

  it('uses beta model discovery and OAuth inference headers', () => {
    expect(buildClaudeCodeModelsUrl('https://api.anthropic.com/')).toBe(
      'https://api.anthropic.com/v1/models?beta=true',
    );
    expect(claudeCodeAuthHeaders({ authToken: 'access' })).toMatchObject({
      Authorization: 'Bearer access',
      'anthropic-beta': 'oauth-2025-04-20',
    });
    expect(claudeCodeAuthHeaders({ apiKey: 'sk-test' })).toMatchObject({
      'x-api-key': 'sk-test',
    });
  });

  it('matches current Claude Code model and beta behavior', () => {
    const priorDisableExperimental = process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS;
    delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS;
    try {
      expect(CLAUDE_CODE_PACKAGE_VERSION).toBe('2.1.215');
      expect(getClaudeCodeBetasForModel('claude-opus-4-8[1m]', true, {
        hasEffort: true,
        hasTools: true,
        promptCacheTtl: '1h',
      })).toEqual([
        'claude-code-20250219',
        'oauth-2025-04-20',
        'context-1m-2025-08-07',
        'interleaved-thinking-2025-05-14',
        'context-management-2025-06-27',
        'prompt-caching-scope-2026-01-05',
        'extended-cache-ttl-2025-04-11',
      ]);
      expect(getClaudeCodeBetasForModel('claude-sonnet-4-6[1m]', true)).toEqual([
        'claude-code-20250219',
        'oauth-2025-04-20',
        'context-1m-2025-08-07',
        'interleaved-thinking-2025-05-14',
        'context-management-2025-06-27',
        'prompt-caching-scope-2026-01-05',
      ]);
    } finally {
      if (priorDisableExperimental === undefined) {
        delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS;
      } else {
        process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = priorDisableExperimental;
      }
    }

    expect(resolveClaudeCodeModel('default', {
      subscriptionType: 'max',
    })).toMatchObject({
      apiModel: 'claude-opus-4-8',
      maxTokens: 64_000,
      effort: 'high',
      thinking: { type: 'adaptive' },
      isOneMillionContext: true,
    });
    expect(resolveClaudeCodeModel('default', {
      subscriptionType: 'pro',
    })).toMatchObject({
      apiModel: 'claude-sonnet-5',
      maxTokens: 64_000,
      effort: 'high',
      isOneMillionContext: true,
    });
    expect(resolveClaudeCodeModel('default', {
      subscriptionType: 'enterprise',
      billingType: 'enterprise_usage_based',
    }).apiModel).toBe('claude-opus-4-8');
    expect(resolveClaudeCodeModel('fable')).toMatchObject({
      apiModel: 'claude-fable-5',
      displayName: 'Fable 5',
      maxTokens: 64_000,
      effort: 'high',
      thinking: { type: 'adaptive' },
      isOneMillionContext: true,
    });
  });
});

describe('Claude Code rate-limit diagnostics', () => {
  it('treats compact overage rejection headers like the official client', () => {
    const snapshot = parseClaudeCodeRateLimitHeaders(new Headers({
      'anthropic-ratelimit-unified-representative-claim': '5h',
      'anthropic-ratelimit-unified-reset': '1770000000',
      'anthropic-ratelimit-unified-overage-status': 'rejected',
      'anthropic-ratelimit-unified-overage-disabled-reason': 'out_of_credits',
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '1770000000',
    }));

    expect(snapshot).toMatchObject({
      status: 'rejected',
      utilization: 1,
      rateLimitType: '5h',
      overageStatus: 'rejected',
      overageDisabledReason: 'out_of_credits',
    });
  });
});

describe('Claude Code OAuth retry', () => {
  it('serializes concurrent refreshes so a rotating refresh token is redeemed once', async () => {
    let refreshCalls = 0;
    const oauthRow: OAuthTokenRow = {
      provider_id: 'claude-code',
      access_token: 'expired-access',
      refresh_token: 'rotating-refresh',
      expires_at: Date.now() - 1_000,
      scope: 'user:profile user:inference',
      extra: { auth_type: 'claude_ai' },
      updated_at: new Date().toISOString(),
    };
    const store = {
      getOAuth: () => oauthRow,
      setOAuth: (row: OAuthTokenRow) => Object.assign(oauthRow, row),
    } as unknown as ProviderStore;

    __setClaudeCodeFetchForTests(async (url) => {
      const asString = String(url);
      if (asString.endsWith('/v1/oauth/token')) {
        refreshCalls += 1;
        await Promise.resolve();
        return new Response(JSON.stringify({
          access_token: 'fresh-access',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
          refresh_token_expires_in: 7200,
          scope: 'user:profile user:inference',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const [a, b] = await Promise.all([
      refreshIfExpired(store, 'claude-code'),
      refreshIfExpired(store, 'claude-code'),
    ]);

    expect(a).toBe('fresh-access');
    expect(b).toBe('fresh-access');
    expect(refreshCalls).toBe(1);
    expect(oauthRow.refresh_token).toBe('rotated-refresh');
    expect(Number(oauthRow.extra?.refresh_token_expires_at)).toBeGreaterThan(Date.now());
  });

  it('refreshes and retries once after a 401', async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const oauthRow: OAuthTokenRow = {
      provider_id: 'claude-code',
      access_token: 'old-access',
      refresh_token: 'refresh-token',
      expires_at: Date.now() + 60_000,
      scope: 'user:profile user:inference',
      extra: { auth_type: 'claude_ai' },
      updated_at: new Date().toISOString(),
    };
    const setOAuthCalls: OAuthTokenRow[] = [];
    const store = {
      getOAuth: () => oauthRow,
      setOAuth: (row: OAuthTokenRow) => {
        setOAuthCalls.push(row);
        oauthRow.access_token = row.access_token;
        oauthRow.refresh_token = row.refresh_token;
        oauthRow.expires_at = row.expires_at;
        oauthRow.scope = row.scope;
        oauthRow.extra = row.extra;
      },
    } as unknown as ProviderStore;

    __setClaudeCodeFetchForTests(async (url, init) => {
      const asString = String(url);
      requests.push({ url: asString, headers: new Headers(init?.headers) });
      if (asString.endsWith('/v1/oauth/token')) {
        return new Response(JSON.stringify({
          access_token: 'fresh-access',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          scope: 'user:profile user:inference',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (asString.endsWith('/api/oauth/profile')) {
        return new Response(JSON.stringify({ account: {}, organization: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (asString.endsWith('/api/oauth/claude_cli/roles')) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (requests.filter((r) => r.url === asString).length === 1) {
        return new Response('expired', { status: 401 });
      }
      return new Response('ok', { status: 200 });
    });

    const retryFetch = createClaudeCodeFetchWithRetry(store, 'claude-code');
    const response = await retryFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer old-access',
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });

    expect(response.status).toBe(200);
    // Token was rotated to the fresh value (proves refresh ran exactly once).
    expect(oauthRow.access_token).toBe('fresh-access');
    expect(setOAuthCalls.length).toBeGreaterThanOrEqual(1);
    const messageRequests = requests.filter((r) => r.url.endsWith('/v1/messages'));
    expect(messageRequests).toHaveLength(2);
    expect(messageRequests[1].headers.get('Authorization')).toBe('Bearer fresh-access');
    expect(messageRequests[1].headers.get('anthropic-beta')).toBe('oauth-2025-04-20');
  });
});
