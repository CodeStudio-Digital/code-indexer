/** OpaqueTokenFactory — 32 bytes of CSPRNG → base64url token (sent to client);
 *  only its SHA-256 hex is persisted. Implements the identity port. */
import type { OpaqueTokenFactory } from '@cloudstudio/cloud-identity';
import { bytesToBase64url } from './base64url.js';
import { sha256Hex } from './sha256.js';

export const opaqueTokens: OpaqueTokenFactory = {
  async issue() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = bytesToBase64url(bytes);
    return { token, hash: await sha256Hex(token) };
  },
  hashOf(token: string) {
    return sha256Hex(token);
  },
};
