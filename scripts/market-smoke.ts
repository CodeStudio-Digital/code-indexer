/**
 * Plugin Market smoke — the security-critical invariant, runnable with no
 * Cloudflare account: the worker's signer (`worker-market/src/sign.ts`,
 * Web Crypto) and the host's verifier (`@mcp/plugin-host` signature.ts,
 * node:crypto) agree over sha256(bundle), AND a tampered bundle / wrong key is
 * rejected (fail-secure). This is the part a CI can prove offline.
 *
 * The FULL publish→search→install round-trip needs a running worker:
 *   1. cd worker-market && wrangler dev               (local D1 + R2)
 *   2. pnpm --filter @mcp/plugin-sdk cli publish <dir> (signs + POST /publish)
 *   3. plugin-host install <name>                      (download + verifyBundle)
 *   4. flip a byte in the bundle → install must REJECT
 * Those steps are operator-run (need wrangler auth); this script gates the
 * crypto boundary they depend on.
 *
 * Run: pnpm tsx scripts/market-smoke.ts   (exit 0 = pass)
 */
import { generateKeyPairSync, createHash, sign, type KeyObject } from 'node:crypto';
import { verifyBundle } from '../packages/plugin-host/src/signature.js';

function fail(msg: string): never {
  console.error(`[market-smoke] FAIL: ${msg}`);
  process.exit(1);
}

/**
 * Mirror of worker-market/src/sign.ts (which uses Web Crypto): sign
 * sha256(bundle) with Ed25519. Ed25519 is deterministic (RFC 8032), so the
 * node:crypto signature is byte-identical to the worker's — the host verifier
 * can't tell them apart, which is exactly the property under test.
 */
function signLikeWorker(privateKey: KeyObject, bundle: Uint8Array): string {
  const digest = createHash('sha256').update(bundle).digest();
  return sign(null, digest, privateKey).toString('base64');
}

async function main(): Promise<void> {
  // keygen.mjs shape: public SPKI PEM (host), private pkcs8 base64 (worker).
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const bundle = new Uint8Array(Buffer.from('fake-plugin-bundle-' + 'x'.repeat(1024)));
  const signature = signLikeWorker(privateKey, bundle);

  if (!verifyBundle(bundle, signature, pubPem)) {
    fail('genuine bundle did not verify — worker signer / host verifier disagree');
  }

  // Tamper: flip one byte → must fail.
  const tampered = Buffer.from(bundle);
  tampered[0] ^= 0xff;
  if (verifyBundle(new Uint8Array(tampered), signature, pubPem)) {
    fail('tampered bundle verified — fail-secure boundary is broken');
  }

  // Wrong key: a different keypair's pubkey must not verify.
  const other = generateKeyPairSync('ed25519');
  const otherPem = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  if (verifyBundle(new Uint8Array(bundle), signature, otherPem)) {
    fail('signature verified under a foreign public key — key pinning is broken');
  }

  console.log('[market-smoke] OK: genuine verifies, tampered rejected, wrong-key rejected.');
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
