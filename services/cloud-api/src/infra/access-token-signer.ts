/**
 * AccessTokenSigner — a minimal HS256 JWT via WebCrypto (no external dep).
 * Short-lived (the use-case sets the TTL); verification is constant-time on the
 * signature and enforces iss/aud/exp. Mirrors the on-device `hmac-jwt-signer.ts`.
 */
import type { AccessClaims, AccessTokenSigner } from '@cloudstudio/cloud-identity';
import { base64urlToBytes, bytesToBase64url, bytesToUtf8, utf8ToBytes } from './base64url.js';

const ISS = 'codestudio-cloud';
const AUD = 'codestudio-app';

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function createAccessTokenSigner(secret: string, clockNow: () => number): AccessTokenSigner {
  const keyPromise = crypto.subtle.importKey(
    'raw',
    utf8ToBytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const hmac = async (data: string): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.sign('HMAC', await keyPromise, utf8ToBytes(data)));

  return {
    async sign(input, ttlSeconds) {
      const iat = Math.floor(clockNow() / 1000);
      const exp = iat + ttlSeconds;
      const header = bytesToBase64url(utf8ToBytes(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
      const payload = bytesToBase64url(
        utf8ToBytes(JSON.stringify({ iss: ISS, aud: AUD, sub: input.sub, sid: input.sid, ev: input.ev, iat, exp })),
      );
      const signingInput = `${header}.${payload}`;
      return `${signingInput}.${bytesToBase64url(await hmac(signingInput))}`;
    },

    async verify(token) {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const [header, payload, sig] = parts;
      const expected = bytesToBase64url(await hmac(`${header}.${payload}`));
      if (!timingSafeEqual(utf8ToBytes(sig), utf8ToBytes(expected))) return null;
      // Pin the algorithm (defense in depth against alg-confusion if this verifier
      // is ever reused) — we only ever sign HS256/JWT.
      let head: { alg?: string; typ?: string };
      try {
        head = JSON.parse(bytesToUtf8(base64urlToBytes(header)));
      } catch {
        return null;
      }
      if (head.alg !== 'HS256' || head.typ !== 'JWT') return null;
      let claims: Partial<AccessClaims> & { iss?: string; aud?: string };
      try {
        claims = JSON.parse(bytesToUtf8(base64urlToBytes(payload)));
      } catch {
        return null;
      }
      const now = Math.floor(clockNow() / 1000);
      if (claims.iss !== ISS || claims.aud !== AUD) return null;
      if (typeof claims.exp !== 'number' || claims.exp <= now) return null;
      if (typeof claims.sub !== 'string' || typeof claims.sid !== 'string') return null;
      return { sub: claims.sub, sid: claims.sid, ev: !!claims.ev, iat: claims.iat ?? now, exp: claims.exp };
    },
  };
}
