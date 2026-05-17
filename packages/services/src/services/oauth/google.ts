/**
 * Google OAuth — PKCE flow with loopback redirect (inspired by gemini-cli).
 *
 * Lets the user "Sign in with Google" and use their Google account to call
 * the Gemini generativelanguage.googleapis.com API without managing an API
 * key manually. Mirrors the Gemini CLI approach.
 *
 * Flow:
 *   1. startOAuthFlow() → generates PKCE verifier/challenge/state, boots a
 *      one-shot HTTP server on 127.0.0.1:1456, returns { authorize_url, state }.
 *   2. UI opens authorize_url in a new tab. User signs in at Google.
 *   3. Loopback server receives GET /auth/callback?code=...&state=...,
 *      validates state, stashes code, responds HTML, and closes.
 *   4. pollFlow(state) → exchanges code at Google's token endpoint for
 *      access_token + refresh_token. Returns { tokens, expires_at }.
 *   5. refreshIfExpired(store, providerId) → re-exchanges refresh_token
 *      when the access token is within 60s of expiry.
 *
 * Client ID & Secret are the same ones used by the Gemini CLI (public,
 * Apache 2.0 licensed). Override via env vars: GOOGLE_OAUTH_CLIENT_ID,
 * GOOGLE_OAUTH_CLIENT_SECRET.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProviderStore } from '@mcp/store/provider-store.js';

// From gemini-cli source (Apache 2.0) — public client for desktop login.
const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_OAUTH_CLIENT_ID ??
  '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET =
  process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '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';

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const GOOGLE_REDIRECT_PORT = 1456;
const GOOGLE_REDIRECT_URI = `http://localhost:${GOOGLE_REDIRECT_PORT}/auth/callback`;

/**
 * Scopes:
 *   - generative-language: required by generativelanguage.googleapis.com
 *   - cloud-platform: broad GCP access (Vertex AI, CodeAssist, etc.)
 *   - userinfo.email + profile: basic profile for display in the admin UI
 *
 * The gemini-cli only uses cloud-platform because it hits the CodeAssist
 * backend, not generativelanguage.googleapis.com. Our SDK calls go through
 * the public Gemini API which needs the specific generative-language scope.
 */
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');

/**
 * Seed models — mirrors the VALID_GEMINI_MODELS allowlist from gemini-cli.
 * Includes all stable + preview models the CLI considers valid for
 * generateContent calls.
 */
export const GOOGLE_SEED_MODELS: { model_id: string; name: string }[] = [
  // Stable (2.5)
  { model_id: 'gemini-2.5-pro',       name: 'Gemini 2.5 Pro' },
  { model_id: 'gemini-2.5-flash',     name: 'Gemini 2.5 Flash' },
  { model_id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite' },
  // Stable (2.0)
  { model_id: 'gemini-2.0-flash',     name: 'Gemini 2.0 Flash' },
  // Preview (3.x)
  { model_id: 'gemini-3-pro-preview',                name: 'Gemini 3 Pro (Preview)' },
  { model_id: 'gemini-3.1-pro-preview',              name: 'Gemini 3.1 Pro (Preview)' },
  { model_id: 'gemini-3.1-pro-preview-customtools',  name: 'Gemini 3.1 Pro Custom Tools (Preview)' },
  { model_id: 'gemini-3-flash-preview',              name: 'Gemini 3 Flash (Preview)' },
  { model_id: 'gemini-3.1-flash-lite-preview',       name: 'Gemini 3.1 Flash Lite (Preview)' },
];

// ─── PKCE helpers ───────────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkce(): { code_verifier: string; code_challenge: string } {
  const code_verifier = base64url(randomBytes(32));
  const code_challenge = base64url(createHash('sha256').update(code_verifier).digest());
  return { code_verifier, code_challenge };
}

// ─── In-process flow state ──────────────────────────────────────

interface PendingFlow {
  code_verifier: string;
  state: string;
  server: Server;
  createdAt: number;
  code?: string;
  error?: string;
}

const pending = new Map<string, PendingFlow>();
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

function cleanupExpired(): void {
  const now = Date.now();
  for (const [state, flow] of pending) {
    if (now - flow.createdAt > FLOW_TIMEOUT_MS) {
      try { flow.server.close(); } catch { /* ignore */ }
      pending.delete(state);
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────

export interface StartFlowResult {
  authorize_url: string;
  state: string;
}

/**
 * Start a new Google PKCE flow. Boots the loopback server on 127.0.0.1:1456
 * and returns the authorize URL the UI should open in a new tab.
 */
export async function startOAuthFlow(): Promise<StartFlowResult> {
  cleanupExpired();

  // Abort any previous in-flight flow — the port can only be bound once.
  for (const [s, f] of pending) {
    try { f.server.close(); } catch { /* ignore */ }
    pending.delete(s);
  }

  const { code_verifier, code_challenge } = generatePkce();
  const state = base64url(randomBytes(16));

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://localhost:${GOOGLE_REDIRECT_PORT}`);
      if (url.pathname !== '/auth/callback') {
        res.writeHead(404).end('not found');
        return;
      }
      const qsState = url.searchParams.get('state') ?? '';
      const qsCode = url.searchParams.get('code') ?? '';
      const qsError = url.searchParams.get('error') ?? '';
      const flow = pending.get(qsState);
      if (!flow || qsState !== flow.state) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(
          '<html><body><h3>Invalid state</h3><p>You can close this tab.</p></body></html>',
        );
        return;
      }
      if (qsError) {
        flow.error = qsError;
      } else if (qsCode) {
        flow.code = qsCode;
      } else {
        flow.error = 'no_code_or_error';
      }
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(
        `<html><body style="font-family:sans-serif;padding:2rem">
          <h3>Connected to Google</h3>
          <p>You can close this tab and return to the dashboard.</p>
          <script>setTimeout(() => window.close(), 500);</script>
        </body></html>`,
      );
      setTimeout(() => {
        try { server.close(); } catch { /* ignore */ }
      }, 200);
    } catch (e) {
      res.writeHead(500).end((e as Error).message);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(GOOGLE_REDIRECT_PORT, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr) {
        reject(new Error('failed to bind loopback server'));
        return;
      }
      resolve();
    });
  });

  pending.set(state, { code_verifier, state, server, createdAt: Date.now() });

  const authorize_url =
    `${GOOGLE_AUTHORIZE_URL}?` +
    new URLSearchParams({
      response_type: 'code',
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: GOOGLE_REDIRECT_URI,
      scope: GOOGLE_SCOPES,
      state,
      code_challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',    // Request refresh_token
      prompt: 'consent',         // Force consent to guarantee refresh_token
    }).toString();

  return { authorize_url, state };
}

// ─── Token exchange ─────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

async function exchangeCode(code: string, codeVerifier: string): Promise<TokenResponse> {
  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      code,
      redirect_uri: GOOGLE_REDIRECT_URI,
      code_verifier: codeVerifier,
    }).toString(),
  });
  if (!r.ok) {
    throw new Error(`Google token exchange failed: HTTP ${r.status} ${await r.text()}`);
  }
  return (await r.json()) as TokenResponse;
}

// ─── Poll ───────────────────────────────────────────────────────

export type PollFlowResult =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'error'; error: string }
  | {
      status: 'authorized';
      access_token: string;
      refresh_token: string | null;
      expires_at: number;
      scope: string;
    };

/**
 * Called by the dashboard on an interval with the state from startOAuthFlow.
 * Returns `pending` until the loopback server captures the code, then
 * exchanges once and returns `authorized`.
 */
export async function pollFlow(state: string): Promise<PollFlowResult> {
  cleanupExpired();
  const flow = pending.get(state);
  if (!flow) return { status: 'expired' };
  if (flow.error) {
    pending.delete(state);
    return { status: 'error', error: flow.error };
  }
  if (!flow.code) return { status: 'pending' };

  try {
    const tok = await exchangeCode(flow.code, flow.code_verifier);
    pending.delete(state);
    const expires_in = tok.expires_in ?? 3600;
    return {
      status: 'authorized',
      access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? null,
      expires_at: Date.now() + expires_in * 1000,
      scope: tok.scope ?? GOOGLE_SCOPES,
    };
  } catch (e) {
    pending.delete(state);
    return { status: 'error', error: (e as Error).message };
  }
}

// ─── Token refresh ──────────────────────────────────────────────

/**
 * Refresh the stored access token when it's within 60s of expiry. Returns
 * the current valid token, or null if nothing is stored yet.
 */
export async function refreshIfExpired(
  store: ProviderStore,
  providerId: string,
): Promise<string | null> {
  const tok = store.getOAuth(providerId);
  if (!tok) return null;

  const now = Date.now();
  const stillValid = tok.expires_at && tok.expires_at - now > 60_000;
  if (stillValid) return tok.access_token;

  if (!tok.refresh_token) return tok.access_token;

  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: tok.refresh_token,
    }).toString(),
  });
  if (!r.ok) {
    throw new Error(`Google token refresh failed: HTTP ${r.status} ${await r.text()}`);
  }
  const data = (await r.json()) as TokenResponse;
  const expires_in = data.expires_in ?? 3600;
  const expires_at = Date.now() + expires_in * 1000;

  store.setOAuth({
    provider_id: providerId,
    access_token: data.access_token,
    // Google doesn't always rotate refresh tokens; keep the old one if absent.
    refresh_token: data.refresh_token ?? tok.refresh_token,
    expires_at,
    scope: tok.scope,
    extra: tok.extra ?? {},
  });

  return data.access_token;
}
