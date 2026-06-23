import { createHash, verify } from 'node:crypto';

/**
 * Verify an Ed25519 signature over sha256(bundle). The hosted market signs
 * the hash of each published bundle; the host re-hashes the downloaded bytes
 * and verifies BEFORE extracting/installing — a server-side trust boundary.
 * `publicKeyPem` is an SPKI PEM string pinned in the host config.
 */
export function verifyBundle(
  bytes: Uint8Array,
  signatureB64: string,
  publicKeyPem: string,
): boolean {
  const digest = createHash('sha256').update(bytes).digest();
  try {
    return verify(null, digest, publicKeyPem, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

export function bundleSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
