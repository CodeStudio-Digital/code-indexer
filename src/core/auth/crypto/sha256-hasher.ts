import { createHash, timingSafeEqual } from 'node:crypto';
import type { TokenHasher } from '../ports/token-hasher.js';

/**
 * Sha256Hasher — single-round SHA-256 of the raw token.
 *
 * Why SHA-256 without bcrypt/argon2: raw tokens here are 256 bits of CSPRNG
 * output (see NodeCryptoRandom). Brute-forcing the preimage is infeasible,
 * so the slow-hash design (which protects low-entropy passwords) is
 * unnecessary and would add latency to every request.
 */
export class Sha256Hasher implements TokenHasher {
  hash(raw: string): string {
    return createHash('sha256').update(raw, 'utf8').digest('hex');
  }

  verify(raw: string, expectedHash: string): boolean {
    const actual = Buffer.from(this.hash(raw), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  }
}
