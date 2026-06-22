/** OAuth state signing + PKCE — HMAC integrity, tamper + TTL rejection. */
import { describe, it, expect } from 'vitest';
import { signState, verifyState, newCodeVerifier, codeChallengeS256, type StatePayload } from '../infra/oauth/state.js';

const SECRET = 'test-state-secret-32-bytes-minimum-xx';
const payload = (over: Partial<StatePayload> = {}): StatePayload => ({
  flow: 'desktop',
  provider: 'google',
  nonce: 'n1',
  port: 7878,
  cv: 'verifier-abc',
  iat: 1_000_000,
  ...over,
});

describe('oauth state', () => {
  it('round-trips a signed state', async () => {
    const tok = await signState(SECRET, payload());
    const out = await verifyState(SECRET, tok, 600_000, 1_000_000);
    expect(out).toMatchObject({ flow: 'desktop', provider: 'google', cv: 'verifier-abc', port: 7878 });
  });

  it('rejects a tampered body', async () => {
    const tok = await signState(SECRET, payload());
    const [body, sig] = tok.split('.');
    const forged = `${body}x.${sig}`;
    expect(await verifyState(SECRET, forged, 600_000, 1_000_000)).toBeNull();
  });

  it('rejects a wrong secret', async () => {
    const tok = await signState(SECRET, payload());
    expect(await verifyState('different-secret-different-different', tok, 600_000, 1_000_000)).toBeNull();
  });

  it('rejects an expired state', async () => {
    const tok = await signState(SECRET, payload({ iat: 1_000_000 }));
    // now is 11 minutes later, maxAge 10 minutes
    expect(await verifyState(SECRET, tok, 600_000, 1_000_000 + 660_000)).toBeNull();
  });

  it('rejects a malformed token', async () => {
    expect(await verifyState(SECRET, 'no-dot-here', 600_000, 1_000_000)).toBeNull();
    expect(await verifyState(SECRET, '', 600_000, 1_000_000)).toBeNull();
  });

  it('PKCE: challenge is the S256 of the verifier and is deterministic', async () => {
    const v = newCodeVerifier();
    const c1 = await codeChallengeS256(v);
    const c2 = await codeChallengeS256(v);
    expect(c1).toBe(c2);
    expect(c1).not.toBe(v);
    expect(c1.length).toBeGreaterThan(20);
  });
});
