/** TOTP (RFC 6238) via WebCrypto HMAC-SHA1. 6 digits, 30s step, ±1 window for
 *  clock skew. Implements the TotpPort. */
import type { TotpPort } from '@cloudstudio/cloud-identity';
import { base32Decode, base32Encode } from './base32.js';

const STEP = 30;
const DIGITS = 6;
const ISSUER = 'CodeStudio';

async function hotp(secret: Uint8Array, counter: number): Promise<string> {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setUint32(0, Math.floor(counter / 2 ** 32));
  dv.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return (bin % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

export const totp: TotpPort = {
  generateSecret() {
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    return base32Encode(bytes);
  },
  keyUri(secret, label) {
    const e = encodeURIComponent;
    return (
      `otpauth://totp/${e(ISSUER)}:${e(label)}` +
      `?secret=${secret}&issuer=${e(ISSUER)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`
    );
  },
  async verify(secret, code) {
    const clean = (code ?? '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(clean)) return null;
    const key = base32Decode(secret);
    const counter = Math.floor(Date.now() / 1000 / STEP);
    for (const w of [-1, 0, 1]) {
      if ((await hotp(key, counter + w)) === clean) return counter + w; // matched absolute step
    }
    return null;
  },
};
