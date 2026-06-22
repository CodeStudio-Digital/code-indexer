/** SHA-256 hex over a UTF-8 string, via workerd WebCrypto. Used for sync content
 *  hashing (no-op re-push detection). */
export async function sha256Hex(input: string): Promise<string> {
  return sha256HexBytes(new TextEncoder().encode(input));
}

/** SHA-256 hex over raw bytes (e.g., a backup blob — integrity anchor). */
export async function sha256HexBytes(input: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', input as BufferSource);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}
