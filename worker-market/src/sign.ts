/**
 * Ed25519 signing over sha256(bundle), using Web Crypto (workerd native).
 * The host (@mcp/plugin-host signature.ts) verifies with node:crypto over the
 * SAME sha256 digest, so we sign the 32-byte digest — not the raw bundle.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function toHex(bytes: Uint8Array): string {
  let h = '';
  for (const b of bytes) h += b.toString(16).padStart(2, '0');
  return h;
}

export interface SignResult {
  sha256: string;
  signature: string;
}

/** Sign sha256(bundle) with the base64 pkcs8 Ed25519 private key. */
export async function signBundle(privateKeyPkcs8B64: string, bundle: ArrayBuffer): Promise<SignResult> {
  const digest = await crypto.subtle.digest('SHA-256', bundle);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    base64ToBytes(privateKeyPkcs8B64),
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('Ed25519', key, digest);
  return {
    sha256: toHex(new Uint8Array(digest)),
    signature: bytesToBase64(new Uint8Array(sig)),
  };
}
