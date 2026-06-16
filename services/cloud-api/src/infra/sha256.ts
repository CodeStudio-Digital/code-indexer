/** SHA-256 → lowercase hex, via WebCrypto. Used to hash opaque refresh tokens
 *  (and IPs) before storage — the raw value is never persisted. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}
