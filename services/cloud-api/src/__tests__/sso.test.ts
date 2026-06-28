/**
 * Org SSO pure pieces: at-rest secret encryption, the anti-takeover domain gate,
 * and the OIDC authorize-URL construction. The full login flow (discovery, token
 * exchange, linking) is integration territory; here we lock down the security-
 * critical logic that must never regress.
 */
import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from '../infra/secret-cipher.js';
import { isEmailDomainAllowed, oidcProvider } from '../infra/oauth/oidc.js';

describe('secret-cipher (client secret at rest)', () => {
  it('round-trips a secret with the same passphrase', async () => {
    const blob = await encryptSecret('a-strong-config-key', 'super-secret-oidc-client-secret');
    expect(blob).not.toContain('super-secret'); // ciphertext, not plaintext
    expect(await decryptSecret('a-strong-config-key', blob)).toBe('super-secret-oidc-client-secret');
  });
  it('produces a different blob each time (random IV)', async () => {
    const a = await encryptSecret('k', 'same-plaintext');
    const b = await encryptSecret('k', 'same-plaintext');
    expect(a).not.toBe(b);
  });
  it('fails to decrypt with the wrong passphrase', async () => {
    const blob = await encryptSecret('right-key', 'x');
    await expect(decryptSecret('wrong-key', blob)).rejects.toBeDefined();
  });
  it('fails to decrypt a tampered blob (GCM integrity)', async () => {
    const blob = await encryptSecret('k', 'payload');
    const tampered = blob.slice(0, -2) + (blob.endsWith('A') ? 'B' : 'A') + blob.slice(-1);
    await expect(decryptSecret('k', tampered)).rejects.toBeDefined();
  });
});

describe('isEmailDomainAllowed (anti-takeover domain gate)', () => {
  it('accepts an exact domain match (case-insensitive)', () => {
    expect(isEmailDomainAllowed('user@Acme.com', ['acme.com'])).toBe(true);
    expect(isEmailDomainAllowed('USER@ACME.COM', ['acme.com'])).toBe(true);
  });
  it('accepts when the domain is one of several allowed', () => {
    expect(isEmailDomainAllowed('u@acme.io', ['acme.com', 'acme.io'])).toBe(true);
  });
  it('rejects a non-listed domain', () => {
    expect(isEmailDomainAllowed('u@evil.com', ['acme.com'])).toBe(false);
  });
  it('rejects a subdomain that is not exactly listed (strict)', () => {
    expect(isEmailDomainAllowed('u@mail.acme.com', ['acme.com'])).toBe(false);
  });
  it('rejects a null email or one without @', () => {
    expect(isEmailDomainAllowed(null, ['acme.com'])).toBe(false);
    expect(isEmailDomainAllowed('not-an-email', ['acme.com'])).toBe(false);
  });
});

describe('oidcProvider.authorizeUrl', () => {
  it('builds a PKCE S256 authorize URL with openid scope', () => {
    const p = oidcProvider('sso:org1', 'client-123', 'secret', {
      authorizationEndpoint: 'https://idp.example.com/authorize',
      tokenEndpoint: 'https://idp.example.com/token',
    });
    const url = new URL(p.authorizeUrl({ state: 'st', redirectUri: 'https://w/cb', codeChallenge: 'chal' }));
    expect(url.origin + url.pathname).toBe('https://idp.example.com/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe('https://w/cb');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('chal');
    expect(url.searchParams.get('state')).toBe('st');
  });
});
