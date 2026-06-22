import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../redact.js';

describe('redactSecrets', () => {
  it('masks JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1Nientabc.eyJzdWIiOiIxMjMentpayload.SflKxwRJSMeKKF2QT4signature';
    expect(redactSecrets(`/v1/me?t=${jwt}`)).not.toContain(jwt);
    expect(redactSecrets(jwt)).toContain('«redacted»');
  });
  it('masks provider key prefixes', () => {
    expect(redactSecrets('Authorization sk-abcdefghijklmnopqrstuvwx')).toContain('«redacted»');
    expect(redactSecrets('sk-abcdefghijklmnopqrstuvwx')).not.toContain('abcdefghijklmnop');
  });
  it('masks a literal Bearer credential but keeps the scheme', () => {
    const out = redactSecrets('Bearer abcdef0123456789abcdef');
    expect(out).toContain('Bearer «redacted»');
  });
  it('redacts credential-named query values but keeps the key', () => {
    expect(redactSecrets('/api?token=supersecretvalue123&page=1')).toBe('/api?token=«redacted»&page=1');
    expect(redactSecrets('/api?api_key=ABCDEF123456')).toContain('api_key=«redacted»');
  });
  it('leaves {{templates}} and normal paths/ids untouched', () => {
    expect(redactSecrets('/users/{{userId}}/posts?token={{token}}')).toBe('/users/{{userId}}/posts?token={{token}}');
    expect(redactSecrets('/users/42/posts?page=2')).toBe('/users/42/posts?page=2');
  });
  it('handles empty/nullish input', () => {
    expect(redactSecrets('')).toBe('');
    expect(redactSecrets(null)).toBe('');
    expect(redactSecrets(undefined)).toBe('');
  });
});
