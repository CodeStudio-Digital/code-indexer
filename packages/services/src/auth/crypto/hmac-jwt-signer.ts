import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../ports/clock.js';
import type { JwtClaims, TokenSigner } from '../ports/token-signer.js';

/**
 * HmacJwtSigner — HS256 JWT signer, no external dependency.
 *
 * Implements the JWT parts we need (header + payload + HMAC-SHA-256 signature,
 * base64url encoding). Single-node deployment model: the same secret signs
 * and verifies. For multi-node, swap with an RS256 adapter — use-cases are
 * unaffected because they depend on the TokenSigner port.
 */
export class HmacJwtSigner implements TokenSigner {
  private readonly header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

  constructor(
    private readonly secret: string,
    private readonly clock: Clock,
  ) {
    if (!secret || secret.length < 32) {
      throw new Error('HmacJwtSigner: secret must be at least 32 characters');
    }
  }

  sign(claims: JwtClaims): string {
    const payload = b64url(JSON.stringify(claims));
    const signingInput = `${this.header}.${payload}`;
    const signature = this.computeSignature(signingInput);
    return `${signingInput}.${signature}`;
  }

  verify(token: string): JwtClaims | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;

    const expected = this.computeSignature(`${header}.${payload}`);
    const a = Buffer.from(signature, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    let claims: JwtClaims;
    try {
      const json = Buffer.from(payload, 'base64url').toString('utf8');
      claims = JSON.parse(json) as JwtClaims;
    } catch {
      return null;
    }

    const nowSec = Math.floor(this.clock.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp <= nowSec) return null;
    return claims;
  }

  private computeSignature(signingInput: string): string {
    return createHmac('sha256', this.secret).update(signingInput).digest('base64url');
  }
}

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}
