/**
 * Snapshot signing round-trip: the adapter signs sha-256(canonical) with
 * WebCrypto Ed25519 (workerd-native); we VERIFY with node:crypto + the SPKI
 * public key — proving a desktop viewer can validate a share offline against the
 * pinned pubkey. Tampering the snapshot must break verification.
 */
import { describe, it, expect } from 'vitest';
import { createHash, createPublicKey, verify as nodeVerify } from 'node:crypto';
import { canonicalize, type ShareSnapshot } from '@cloudstudio/cloud-sharing';
import { createSnapshotSigner } from '../infra/ed25519-signer.js';

// Dev-only keypair (matches .dev.vars).
const PRIV_PKCS8_B64 = 'MC4CAQAwBQYDK2VwBCIEIICoyP6yhI1xiZ9wMbSGRR12lp7t4R/1lnRxcq9xnuKt';
const PUB_SPKI_B64 = 'MCowBQYDK2VwAyEAmhOYcyhSTtGm2o6fxmI4QAmFV9c/gCxAzs4cZYJ+npg=';

const pubKey = createPublicKey({ key: Buffer.from(PUB_SPKI_B64, 'base64'), format: 'der', type: 'spki' });
const signer = createSnapshotSigner(PRIV_PKCS8_B64);

function snap(title: string): ShareSnapshot {
  return { schemaVersion: 1, title, model: 'm', createdAtMs: 1_700_000_000_000, messages: [{ idx: 0, role: 'user', blocks: [{ type: 'text', text: 'hi' }] }] };
}

describe('Ed25519 snapshot signer', () => {
  it('produces a signature node:crypto verifies against the digest', async () => {
    const canonical = canonicalize(snap('hello'));
    const { sha256, signature } = await signer.sign(canonical);

    const digest = createHash('sha256').update(Buffer.from(canonical)).digest();
    expect(digest.toString('hex')).toBe(sha256); // adapter's sha256 matches node's

    const ok = nodeVerify(null, digest, pubKey, Buffer.from(signature, 'base64'));
    expect(ok).toBe(true);
  });

  it('fails verification when the snapshot is tampered', async () => {
    const { signature } = await signer.sign(canonicalize(snap('original')));
    const tamperedDigest = createHash('sha256').update(Buffer.from(canonicalize(snap('tampered')))).digest();
    expect(nodeVerify(null, tamperedDigest, pubKey, Buffer.from(signature, 'base64'))).toBe(false);
  });
});
