import { bytesToBase64url, base64urlToBytes, utf8ToBytes } from '../infra/base64url.js';
import type { GitHubAppConfig } from './types.js';

export interface GitHubConnectState {
  accountId: string;
  sessionId: string;
  nonce: string;
  installationId?: number;
  iat: number;
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', utf8ToBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8ToBytes(value)));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function signGitHubConnectState(secret: string, state: GitHubConnectState): Promise<string> {
  const body = bytesToBase64url(utf8ToBytes(JSON.stringify(state)));
  return `${body}.${bytesToBase64url(await hmac(secret, body))}`;
}

export async function verifyGitHubConnectState(
  secret: string,
  token: string,
  nowMs: number,
  maxAgeMs = 10 * 60 * 1000,
): Promise<GitHubConnectState | null> {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  try {
    const expected = await hmac(secret, body);
    if (!constantTimeEqual(expected, base64urlToBytes(token.slice(dot + 1)))) return null;
    const state = JSON.parse(new TextDecoder().decode(base64urlToBytes(body))) as GitHubConnectState;
    if (!state.accountId || !state.sessionId || !state.nonce || typeof state.iat !== 'number') return null;
    if (nowMs < state.iat - 60_000 || nowMs - state.iat > maxAgeMs) return null;
    if (state.installationId !== undefined && (!Number.isSafeInteger(state.installationId) || state.installationId <= 0)) return null;
    return state;
  } catch {
    return null;
  }
}

function encodeJwtPart(value: unknown): string {
  return bytesToBase64url(utf8ToBytes(JSON.stringify(value)));
}

export async function createGitHubAppJwt(config: GitHubAppConfig, nowMs = Date.now()): Promise<string> {
  const now = Math.floor(nowMs / 1000);
  const unsigned = `${encodeJwtPart({ alg: 'RS256', typ: 'JWT' })}.${encodeJwtPart({ iat: now - 60, exp: now + 540, iss: config.appId })}`;
  const key = await crypto.subtle.importKey(
    'jwk',
    config.privateKeyJwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf8ToBytes(unsigned));
  return `${unsigned}.${bytesToBase64url(new Uint8Array(signature))}`;
}
