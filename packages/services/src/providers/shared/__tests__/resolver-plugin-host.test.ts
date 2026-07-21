import { describe, expect, it, vi } from 'vitest';
import type { ProviderDefinition } from '@mcp/provider-sdk';
import type { ProviderConfig } from '@mcp/store/provider-store.js';

const oauth = vi.hoisted(() => ({
  resolveClaudeCodeCreds: vi.fn(),
  resolveCopilotCreds: vi.fn(),
  resolveChatGPTCreds: vi.fn(),
  resolveGoogleOAuthCreds: vi.fn(),
  runOAuthRefresh: vi.fn(),
}));

vi.mock('../oauth.js', () => oauth);

import { resolveCreds } from '../resolver.js';

describe('plugin-owned credential resolution', () => {
  it('supplies Claude Code with a host-owned credential resolver', async () => {
    const cfg = {
      id: 'claude',
      kind: 'claude-code',
      name: 'Claude Code',
      api_key: null,
      base_url: null,
      auth_mode: 'oauth',
      enabled: true,
      use_for_agent: false,
      use_for_coder: true,
      use_for_general: false,
      is_default: false,
      extra: {},
      fallback_provider_id: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    } satisfies ProviderConfig;
    const expected = { authToken: 'host-token', baseURL: 'https://api.anthropic.com' };
    oauth.resolveClaudeCodeCreds.mockResolvedValueOnce(expected);
    const def = {
      kind: 'claude-code',
      credKind: 'oauth',
      async resolveCredentials(ctx) {
        if (!ctx.resolveHostCredentials) throw new Error('missing host resolver');
        return ctx.resolveHostCredentials();
      },
    } as ProviderDefinition;

    await expect(resolveCreds(def, cfg)).resolves.toEqual(expected);
    expect(oauth.resolveClaudeCodeCreds).toHaveBeenCalledWith(cfg);
  });
});
