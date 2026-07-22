import { describe, expect, it, vi } from 'vitest';
import { openClaudeCodeAuthorization } from '../claude-code-authorization.js';

const urls = {
  authorizeUrl: 'https://claude.test/authorize?redirect_uri=http://localhost/callback',
  manualAuthorizeUrl: 'https://claude.test/authorize?redirect_uri=https://platform.test/code/callback',
};

describe('Claude Code authorization browser flow', () => {
  it('reopens the automatic PKCE URL after the user signs in', () => {
    const openExternal = vi.fn();

    expect(openClaudeCodeAuthorization(urls, 'automatic', {
      openExternal,
      openWindow: vi.fn(),
    })).toBe(true);
    expect(openExternal).toHaveBeenCalledWith(urls.authorizeUrl);
  });

  it('uses the manual redirect only when the user explicitly selects code authorization', () => {
    const openWindow = vi.fn();

    expect(openClaudeCodeAuthorization(urls, 'manual', { openWindow })).toBe(true);
    expect(openWindow).toHaveBeenCalledWith(urls.manualAuthorizeUrl);
  });
});
