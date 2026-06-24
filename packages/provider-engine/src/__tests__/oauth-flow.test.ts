import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createPkcePair, base64url } from '../oauth/pkce.js';
import { buildAuthorizeUrl, resolveAuthorizeUrl, loopbackRedirectUri } from '../oauth/authorize.js';
import { refreshTokenGrant, applyRefresh } from '../oauth/token.js';
import { chatgptSpec } from '../specs/chatgpt.js';
import { googleOAuthSpec } from '../specs/google-oauth.js';
import { claudeCodeSpec } from '../specs/claude-code.js';

describe('generic OAuth engine (spec.auth-driven)', () => {
  it('createPkcePair is a valid RFC-7636 S256 pair', () => {
    const p = createPkcePair();
    expect(p.method).toBe('S256');
    expect(p.code_challenge).toBe(base64url(createHash('sha256').update(p.code_verifier).digest()));
    expect(p.code_verifier).not.toContain('=');
  });

  it('chatgpt: authorize URL reproduces the legacy openai flow (incl. the 3 Codex params)', () => {
    const url = new URL(
      buildAuthorizeUrl(chatgptSpec.auth!, {
        redirectUri: loopbackRedirectUri(chatgptSpec.auth!),
        state: 'ST',
        codeChallenge: 'CH',
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe('https://auth.openai.com/oauth/authorize');
    const q = url.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe(chatgptSpec.auth!.clientId);
    expect(q.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(q.get('scope')).toBe('openid profile email offline_access');
    expect(q.get('state')).toBe('ST');
    expect(q.get('code_challenge')).toBe('CH');
    expect(q.get('code_challenge_method')).toBe('S256');
    // the Codex-specific params that the id_token's chatgpt_account_id depends on
    expect(q.get('id_token_add_organizations')).toBe('true');
    expect(q.get('codex_cli_simplified_flow')).toBe('true');
    expect(q.get('originator')).toBe('codex_cli_rs');
  });

  it('google: authorize URL carries access_type=offline + prompt=consent', () => {
    const q = new URL(
      buildAuthorizeUrl(googleOAuthSpec.auth!, {
        redirectUri: loopbackRedirectUri(googleOAuthSpec.auth!),
        state: 'S',
        codeChallenge: 'C',
      }),
    ).searchParams;
    expect(q.get('access_type')).toBe('offline');
    expect(q.get('prompt')).toBe('consent');
  });

  it('claude-code: authorize host is chosen by the requested scope set', () => {
    const a = claudeCodeSpec.auth!;
    expect(resolveAuthorizeUrl(a, ['user:inference', 'user:profile'])).toBe('https://claude.com/cai/oauth/authorize');
    expect(resolveAuthorizeUrl(a, ['org:create_api_key', 'user:profile'])).toBe(
      'https://platform.claude.com/oauth/authorize',
    );
  });

  it('refresh-token grant: form body + client_secret only when the spec has one', async () => {
    const bodies: string[] = [];
    const mock = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      bodies.push(init?.body ?? '');
      return new Response(JSON.stringify({ access_token: 'new', expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;

    await refreshTokenGrant(chatgptSpec.auth!, { refreshToken: 'rt', scope: 'openid profile', fetchImpl: mock });
    const chat = new URLSearchParams(bodies[0]);
    expect(chat.get('grant_type')).toBe('refresh_token');
    expect(chat.get('client_id')).toBe(chatgptSpec.auth!.clientId);
    expect(chat.get('refresh_token')).toBe('rt');
    expect(chat.get('scope')).toBe('openid profile');
    expect(chat.get('client_secret')).toBeNull(); // chatgpt is a public client

    await refreshTokenGrant(googleOAuthSpec.auth!, { refreshToken: 'g', fetchImpl: mock });
    const goog = new URLSearchParams(bodies[1]);
    expect(goog.get('client_secret')).toBe(googleOAuthSpec.auth!.clientSecret); // google is confidential
  });

  describe('applyRefresh — the lockout-critical persistence invariants', () => {
    const prev = {
      access_token: 'old',
      refresh_token: 'rt-old',
      scope: 'openid',
      extra: { id_token: 'jwt-old', projectId: 'P-1' },
    };

    it('keeps the old refresh_token when the response omits one + merges extra', () => {
      const out = applyRefresh('p', prev, { access_token: 'new', expires_in: 3600 });
      expect(out.access_token).toBe('new');
      expect(out.refresh_token).toBe('rt-old'); // rotation-tolerant
      expect(out.extra).toEqual({ id_token: 'jwt-old', projectId: 'P-1' }); // extra preserved (projectId!)
      expect(out.expires_at).toBeGreaterThan(Date.now() + 3590_000);
    });

    it('rotates the refresh_token + updates id_token when the response carries them', () => {
      const out = applyRefresh('p', prev, { access_token: 'new', refresh_token: 'rt-new', id_token: 'jwt-new' });
      expect(out.refresh_token).toBe('rt-new');
      expect(out.extra).toEqual({ id_token: 'jwt-new', projectId: 'P-1' }); // id_token updated, projectId kept
    });
  });
});
