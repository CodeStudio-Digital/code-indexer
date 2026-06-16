/** One-time recovery codes (`XXXXX-XXXXX`, base32). Only SHA-256 hashes are
 *  stored; verification normalizes input the same way they were generated. */
import type { RecoveryCodeService } from '@cloudstudio/cloud-identity';
import { base32Encode } from './base32.js';
import { sha256Hex } from './sha256.js';

// Canonicalize away presentation (hyphen, spaces) so 'ABCDE-FGHIJ',
// 'abcdefghij', and 'ABCDE FGHIJ' all hash identically — otherwise a user who
// drops the separator silently burns their only recovery path.
function normalize(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z2-7]/g, '');
}

function generateCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const s = base32Encode(bytes).slice(0, 10);
  return `${s.slice(0, 5)}-${s.slice(5, 10)}`;
}

export const recoveryCodes: RecoveryCodeService = {
  async generate(count) {
    const out: { code: string; hash: string }[] = [];
    for (let i = 0; i < count; i++) {
      const code = generateCode();
      out.push({ code, hash: await sha256Hex(normalize(code)) });
    }
    return out;
  },
  hashOf(code) {
    return sha256Hex(normalize(code));
  },
};
