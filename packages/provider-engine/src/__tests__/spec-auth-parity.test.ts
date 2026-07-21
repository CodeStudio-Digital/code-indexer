import { describe, it, expect } from 'vitest';
import {
  OPENAI_CLIENT_ID,
  OPENAI_AUTHORIZE_URL,
  OPENAI_TOKEN_URL,
  OPENAI_SCOPES,
} from '@mcp/services/services/oauth/openai.js';
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_SCOPES,
} from '@mcp/services/services/oauth/google.js';
import { COPILOT_CLIENT_ID } from '@mcp/services/services/oauth/copilot.js';
import {
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_CODE_AUTHORIZE_URL,
  CLAUDE_CODE_CONSOLE_AUTHORIZE_URL,
  CLAUDE_CODE_TOKEN_URL,
  CLAUDE_CODE_REDIRECT_PORT,
} from '@mcp/services/services/oauth/claude-code.js';
import { chatgptSpec } from '../specs/chatgpt.js';
import { googleOAuthSpec } from '../specs/google-oauth.js';
import { kimiCodeSpec } from '../specs/kimi.js';
import { copilotSpec } from '../specs/copilot.js';
import { claudeCodeSpec } from '../specs/claude-code.js';

/**
 * `spec.auth` is the declarative form of each OAuth provider's connect config —
 * pure data inlined into the (leaf) spec so a third-party plugin can author the
 * same shape. This test pins those inlined literals to the live source-of-truth
 * constants in services/oauth/*, so the declarative descriptors cannot silently
 * drift from the flows they describe (the foundation for the OAuth-engine phase).
 */
describe('spec.auth parity — declarative descriptors == services/oauth source of truth', () => {
  it('chatgpt (authorization-code)', () => {
    const a = chatgptSpec.auth!;
    expect(a.clientId).toBe(OPENAI_CLIENT_ID);
    expect(a.authorizeUrl).toBe(OPENAI_AUTHORIZE_URL);
    expect(a.tokenUrl).toBe(OPENAI_TOKEN_URL);
    expect(a.scopes!.join(' ')).toBe(OPENAI_SCOPES);
    expect(a.flavor).toBe('authorization-code');
    expect(a.redirect).toEqual({ port: 1455, path: '/auth/callback' });
    expect(a.authorizeParams).toEqual({
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
    });
  });

  it('google-oauth (authorization-code + client_secret)', () => {
    const a = googleOAuthSpec.auth!;
    expect(a.clientId).toBe(GOOGLE_CLIENT_ID);
    expect(a.clientSecret).toBe(GOOGLE_CLIENT_SECRET);
    expect(a.authorizeUrl).toBe(GOOGLE_AUTHORIZE_URL);
    expect(a.tokenUrl).toBe(GOOGLE_TOKEN_URL);
    expect(a.scopes!.join(' ')).toBe(GOOGLE_SCOPES);
    expect(a.authorizeParams).toEqual({ access_type: 'offline', prompt: 'consent' });
  });

  it('kimi-code is API-key-only and exposes no OAuth descriptor', () => {
    expect(kimiCodeSpec.credKind).toBe('api-key');
    expect(kimiCodeSpec.auth).toBeUndefined();
    expect(kimiCodeSpec.envVars).toEqual(['KIMI_CODE_API_KEY']);
  });

  it('copilot (pat-exchange)', () => {
    const a = copilotSpec.auth!;
    expect(a.clientId).toBe(COPILOT_CLIENT_ID);
    expect(a.flavor).toBe('pat-exchange');
    expect(a.deviceAuthUrl).toBe('https://github.com/login/device/code');
    expect(a.tokenUrl).toBe('https://github.com/login/oauth/access_token');
    expect(a.scopes).toEqual(['read:user']);
  });

  it('claude-code (authorization-code; authorize host by scope)', () => {
    const a = claudeCodeSpec.auth!;
    expect(a.clientId).toBe(CLAUDE_CODE_CLIENT_ID);
    expect(a.tokenUrl).toBe(CLAUDE_CODE_TOKEN_URL);
    expect(a.redirect!.port).toBe(CLAUDE_CODE_REDIRECT_PORT);
    const byScope = a.authorizeUrlByScope!;
    expect(byScope.find((x) => x.whenScope === 'user:inference')!.url).toBe(CLAUDE_CODE_AUTHORIZE_URL);
    expect(byScope.find((x) => x.whenScope === 'org:create_api_key')!.url).toBe(CLAUDE_CODE_CONSOLE_AUTHORIZE_URL);
  });

  it('all 4 OAuth specs declare mode oauth + hooks keyed by kind', () => {
    const oauth = [chatgptSpec, googleOAuthSpec, copilotSpec, claudeCodeSpec];
    for (const s of oauth) {
      expect(s.credKind).toBe('oauth');
      expect(s.auth?.mode).toBe('oauth');
      expect(s.auth?.hooks).toBe(s.kind); // host exotic-hook module is keyed by kind
    }
  });
});
