/**
 * OAuth `state` signing + PKCE helpers. The worker is STATELESS between
 * /start and /callback: the PKCE code_verifier rides INSIDE the HMAC-signed
 * `state` (it only becomes useful together with the auth `code`, which the client
 * never holds). The signed state is also the CSRF token — a callback whose state
 * fails the HMAC or is older than the TTL is rejected.
 */
import { bytesToBase64url, base64urlToBytes, utf8ToBytes } from '../base64url.js';

function randomB64url(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return bytesToBase64url(b);
}

/** PKCE: a high-entropy verifier + its S256 challenge. */
export function newCodeVerifier(): string {
  return randomB64url(32);
}
export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8ToBytes(verifier));
  return bytesToBase64url(new Uint8Array(digest));
}

async function hmac(secret: string, msg: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', utf8ToBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8ToBytes(msg)));
}
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export interface StatePayload {
  flow: 'desktop' | 'portal';
  provider: string;
  nonce: string;
  /** Desktop loopback port (desktop flow only). */
  port?: number;
  /** Org id for the SSO flow (provider === 'sso'); the callback is org-agnostic. */
  orgId?: string;
  /** PKCE code verifier (carried server-side via the signed state). */
  cv: string;
  /** Issued-at epoch ms (TTL check). */
  iat: number;
}

export async function signState(secret: string, p: StatePayload): Promise<string> {
  const body = bytesToBase64url(utf8ToBytes(JSON.stringify(p)));
  const sig = bytesToBase64url(await hmac(secret, body));
  return `${body}.${sig}`;
}

export async function verifyState(secret: string, token: string, maxAgeMs: number, nowMs: number): Promise<StatePayload | null> {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let actual: Uint8Array;
  try {
    actual = base64urlToBytes(sig);
  } catch {
    return null;
  }
  const expected = await hmac(secret, body);
  if (!timingSafeEqual(expected, actual)) return null;
  let p: StatePayload;
  try {
    p = JSON.parse(new TextDecoder().decode(base64urlToBytes(body))) as StatePayload;
  } catch {
    return null;
  }
  if (typeof p.iat !== 'number' || nowMs - p.iat > maxAgeMs) return null;
  return p;
}
