/**
 * Symmetric encryption for secrets stored at rest in D1 (today: per-org OIDC client
 * secrets). AES-256-GCM via WebCrypto; the key is SHA-256 of the env passphrase
 * `SSO_CONFIG_KEY` (so any sufficiently-strong secret works, no base64 fuss). The
 * blob is base64url(iv(12) || ciphertext+tag) — GCM's tag gives integrity, so a
 * tampered ciphertext fails `decrypt` rather than returning garbage.
 */
import { bytesToBase64url, base64urlToBytes, utf8ToBytes } from './base64url.js';

async function deriveKey(secret: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest('SHA-256', utf8ToBytes(secret));
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(passphrase: string, plaintext: string): Promise<string> {
  const key = await deriveKey(passphrase);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8ToBytes(plaintext)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return bytesToBase64url(out);
}

/** Decrypt a blob from `encryptSecret`. Throws on a bad key or tampered ciphertext. */
export async function decryptSecret(passphrase: string, blob: string): Promise<string> {
  const key = await deriveKey(passphrase);
  const all = base64urlToBytes(blob);
  const iv = all.slice(0, 12);
  const ct = all.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}
