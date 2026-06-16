/**
 * PasswordHasher via PBKDF2-HMAC-SHA256 (WebCrypto). This is the Workers-native
 * path: Cloudflare disallows runtime `WebAssembly.compile`, so WASM Argon2
 * (hash-wasm) cannot run on workerd — decision #6's documented fallback. 600k
 * iterations is the OWASP-2023 floor for PBKDF2-HMAC-SHA256.
 *
 * Storage format (self-describing, so cost can be raised + old hashes upgraded
 * on next login via `needsRehash`): `pbkdf2-sha256$<iterations>$<saltB64url>$<dkB64url>`.
 *
 * NOTE: PBKDF2 is not memory-hard like Argon2id. A future hardening option is
 * Argon2id compiled to a STATICALLY-IMPORTED `.wasm` module (allowed on Workers,
 * unlike runtime compile) behind this same port — no domain/app changes needed.
 */
import type { PasswordHasher } from '@cloudstudio/cloud-identity';
import { base64urlToBytes, bytesToBase64url, utf8ToBytes } from './base64url.js';

const PREFIX = 'pbkdf2-sha256';
const ITERATIONS = 600_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

async function deriveBits(plain: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey('raw', utf8ToBytes(plain), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, keyMaterial, KEY_BITS);
  return new Uint8Array(bits);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

interface Parsed {
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
}
function parse(phc: string): Parsed | null {
  const parts = phc.split('$');
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return null;
  try {
    return { iterations, salt: base64urlToBytes(parts[2]), hash: base64urlToBytes(parts[3]) };
  } catch {
    return null;
  }
}

async function hashPassword(plain: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const dk = await deriveBits(plain, salt, ITERATIONS);
  return `${PREFIX}$${ITERATIONS}$${bytesToBase64url(salt)}$${bytesToBase64url(dk)}`;
}

let dummyHashPromise: Promise<string> | null = null;

export const pbkdf2Hasher: PasswordHasher = {
  hash: hashPassword,
  async verify(plain, phc) {
    const parsed = parse(phc);
    if (!parsed) return false;
    const dk = await deriveBits(plain, parsed.salt, parsed.iterations);
    return timingSafeEqual(dk, parsed.hash);
  },
  needsRehash(phc) {
    const parsed = parse(phc);
    return !parsed || parsed.iterations < ITERATIONS;
  },
  async dummyVerify(plain) {
    if (!dummyHashPromise) dummyHashPromise = hashPassword('cs_dummy_timing_constant_v1');
    const parsed = parse(await dummyHashPromise);
    if (parsed) {
      const dk = await deriveBits(plain, parsed.salt, parsed.iterations);
      timingSafeEqual(dk, parsed.hash); // mirror verify's work exactly (timing symmetry)
    }
  },
};
