import { describe, it, expect, beforeEach } from 'vitest';
import {
  mintPreviewToken,
  verifyPreviewToken,
  formatSetCookie,
  PREVIEW_COOKIE,
} from '../apps/http-api/server/routes/preview-auth.js';

describe('preview-auth HMAC cookie', () => {
  beforeEach(() => {
    // Pin a deterministic secret per-test so mint/verify don't diverge
    // across runs and so we can hand-craft attack tokens below.
    process.env.MCP_PREVIEW_SECRET = 'test-secret-that-is-at-least-32-bytes-long!!';
    // The secret is cached on first read. Our tests all use the same
    // value so this is harmless in practice; if we ever rotate
    // secrets across tests we'll need a module-level reset export.
  });

  it('mints a cookie that verifies for the same session', () => {
    const token = mintPreviewToken('42');
    const cookie = `${PREVIEW_COOKIE}=${token.value}`;
    expect(verifyPreviewToken(cookie, '42')).toBe(true);
  });

  it('rejects cookies for a different session', () => {
    const token = mintPreviewToken('42');
    const cookie = `${PREVIEW_COOKIE}=${token.value}`;
    expect(verifyPreviewToken(cookie, '43')).toBe(false);
  });

  it('rejects tampered HMAC', () => {
    const token = mintPreviewToken('42');
    // Flip one char of the hmac — HMAC mismatch must be detected.
    const tampered = token.value.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
    const cookie = `${PREVIEW_COOKIE}=${tampered}`;
    expect(verifyPreviewToken(cookie, '42')).toBe(false);
  });

  it('rejects validly-signed-but-expired cookies', () => {
    // Negative TTL mints a token whose HMAC is correct but whose exp
    // is already in the past — proves the time check fires even when
    // the signature check would pass.
    const token = mintPreviewToken('42', -1000);
    const cookie = `${PREVIEW_COOKIE}=${token.value}`;
    expect(verifyPreviewToken(cookie, '42')).toBe(false);
  });

  it('ignores other cookies in the same header', () => {
    const token = mintPreviewToken('42');
    const cookie = `session=foo; ${PREVIEW_COOKIE}=${token.value}; theme=dark`;
    expect(verifyPreviewToken(cookie, '42')).toBe(true);
  });

  it('returns false on missing header', () => {
    expect(verifyPreviewToken(undefined, '42')).toBe(false);
    expect(verifyPreviewToken('', '42')).toBe(false);
  });

  it('formatSetCookie emits HttpOnly + SameSite=Strict scoped to /preview/', () => {
    const token = mintPreviewToken('42');
    const header = formatSetCookie(token, { secure: true });
    expect(header).toContain(`${PREVIEW_COOKIE}=`);
    expect(header).toContain('Path=/preview/');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain('Secure');
    expect(header).toContain('Expires=');
  });
});
