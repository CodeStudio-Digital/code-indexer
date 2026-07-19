import { describe, expect, it } from 'vitest';
import { createGitHubAppJwt, signGitHubConnectState, verifyGitHubConnectState } from '../github-app/crypto.js';
import type { GitHubAppConfig } from '../github-app/types.js';

const SECRET = 'github-app-state-secret-at-least-32-bytes';

describe('GitHub App connection state', () => {
  it('round-trips account and session identity', async () => {
    const token = await signGitHubConnectState(SECRET, {
      accountId: 'acc_1', sessionId: 'ses_1', nonce: 'nonce', installationId: 42, iat: 1_000_000,
    });
    expect(await verifyGitHubConnectState(SECRET, token, 1_000_100)).toMatchObject({
      accountId: 'acc_1', sessionId: 'ses_1', installationId: 42,
    });
  });

  it('rejects tampering and expiry', async () => {
    const token = await signGitHubConnectState(SECRET, {
      accountId: 'acc_1', sessionId: 'ses_1', nonce: 'nonce', iat: 1_000_000,
    });
    expect(await verifyGitHubConnectState(SECRET, `${token}x`, 1_000_100)).toBeNull();
    expect(await verifyGitHubConnectState(SECRET, token, 1_700_001)).toBeNull();
  });
});

describe('GitHub App JWT', () => {
  it('uses RS256 with the configured App id and a short expiry', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    );
    const privateKeyJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const config: GitHubAppConfig = {
      appId: 4329188,
      slug: 'megabrainstudio',
      clientId: 'client',
      clientSecret: 'secret',
      privateKeyJwk,
      stateSecret: SECRET,
      host: 'github.com',
      webUrl: 'https://github.com',
      apiUrl: 'https://api.github.com',
    };
    const jwt = await createGitHubAppJwt(config, 2_000_000);
    const [headerPart, payloadPart, signaturePart] = jwt.split('.') as [string, string, string];
    const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(decode(headerPart)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decode(payloadPart)).toMatchObject({ iss: 4329188, iat: 1940, exp: 2540 });
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      pair.publicKey,
      Buffer.from(signaturePart, 'base64url'),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
    expect(valid).toBe(true);
  });
});
