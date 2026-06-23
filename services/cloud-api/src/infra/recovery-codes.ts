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
  // Deliberate ~64-bit budget: 8 CSPRNG bytes → 13 base32 chars, NO truncation
  // (the old `.slice(0,10)` silently threw away ~14 bits, leaving only ~50).
  // Displayed as XXXXX-XXXXX-XXX; the hyphens are stripped by `normalize`.
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const s = base32Encode(bytes).replace(/=+$/, '');
  return `${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10)}`;
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
