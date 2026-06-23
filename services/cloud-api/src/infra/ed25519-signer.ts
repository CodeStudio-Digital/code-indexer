/**
 * SnapshotSigner over WebCrypto Ed25519 (workerd-native), reusing the
 * `worker-market/src/sign.ts` approach: we sign sha-256(canonical) — the 32-byte
 * digest, not the raw bytes — so an offline verifier (the desktop viewer, with
 * node:crypto) can check it against the same digest. The signing key is a base64
 * PKCS8 Ed25519 private key from a Worker secret.
 */
import type { SnapshotSigner } from '@cloudstudio/cloud-sharing';

export function createSnapshotSigner(privateKeyPkcs8B64: string): SnapshotSigner {
  return {
    async sign(canonical: Uint8Array) {
      const digest = await crypto.subtle.digest('SHA-256', canonical as BufferSource);
      const key = await crypto.subtle.importKey('pkcs8', base64ToBytes(privateKeyPkcs8B64), { name: 'Ed25519' }, false, ['sign']);
      const sig = await crypto.subtle.sign('Ed25519', key, digest);
      return { sha256: toHex(new Uint8Array(digest)), signature: bytesToBase64(new Uint8Array(sig)) };
    },
  };
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function toHex(bytes: Uint8Array): string {
  let h = '';
  for (const b of bytes) h += b.toString(16).padStart(2, '0');
  return h;
}
