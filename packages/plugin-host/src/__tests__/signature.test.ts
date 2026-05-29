/**
 * Verifies the host's verifyBundle against an Ed25519 signature over
 * sha256(bundle) — the exact scheme worker-market/src/sign.ts implements.
 * If this passes, a bundle signed by the market verifies on the host.
 */
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, createHash, sign as nodeSign } from 'node:crypto';
import { verifyBundle } from '../signature.js';

function makeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pubPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey };
}

function signDigest(bytes: Uint8Array, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']): string {
  const digest = createHash('sha256').update(bytes).digest();
  return nodeSign(null, digest, privateKey).toString('base64');
}

describe('verifyBundle', () => {
  it('accepts a valid Ed25519 signature over sha256(bundle)', () => {
    const { pubPem, privateKey } = makeKeys();
    const bytes = new TextEncoder().encode('a plugin bundle');
    expect(verifyBundle(bytes, signDigest(bytes, privateKey), pubPem)).toBe(true);
  });

  it('rejects a tampered bundle', () => {
    const { pubPem, privateKey } = makeKeys();
    const sig = signDigest(new TextEncoder().encode('original'), privateKey);
    expect(verifyBundle(new TextEncoder().encode('TAMPERED'), sig, pubPem)).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const a = makeKeys();
    const b = makeKeys();
    const bytes = new TextEncoder().encode('bundle');
    expect(verifyBundle(bytes, signDigest(bytes, b.privateKey), a.pubPem)).toBe(false);
  });
});
