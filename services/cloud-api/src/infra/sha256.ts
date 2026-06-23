/** SHA-256 → lowercase hex, via WebCrypto. Correct ONLY for HIGH-ENTROPY,
 *  unguessable preimages (opaque refresh tokens, recovery codes, challenge
 *  tokens) where a bare digest is not brute-forceable and must be deterministic
 *  for lookup. NEVER use it for IPs/emails — those are low-entropy and reversible;
 *  use `hashPii` instead. */
export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
}

/**
 * Peppered hash for low-entropy PII (IP addresses, emails). HMAC-SHA256 keyed by
 * a server-side secret pepper so the digest is NOT precomputable — a bare SHA-256
 * of an IPv4 (2^32 space) or a known email is trivially reversed by a rainbow
 * table. The pepper comes from `Env.IP_HASH_SALT`; an empty pepper degrades to a
 * keyless HMAC (still reversible) so prod MUST set the secret.
 */
export async function hashPii(value: string, pepper: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}
