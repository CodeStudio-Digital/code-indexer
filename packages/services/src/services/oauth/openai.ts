/**
 * OpenAI OAuth — Codex CLI-style PKCE flow against auth.openai.com.
 *
 * This lets the user connect their ChatGPT Plus/Pro/Team subscription as a
 * coder agent backend, instead of (or alongside) an OpenAI Platform API key.
 * It's the same flow the open-source Codex CLI uses: PKCE with a loopback
 * redirect on http://localhost:1455/auth/callback.
 *
 * Flow:
 *   1. startOAuthFlow() → generates verifier/challenge/state, boots a
 *      one-shot HTTP server on 127.0.0.1:1455 that resolves a Promise when
 *      the callback arrives. Returns { authorize_url, state }.
 *   2. UI opens authorize_url in a new tab. User signs in at OpenAI.
 *   3. Loopback server receives GET /auth/callback?code=...&state=...,
 *      validates state, stashes code in the pending map, responds HTML,
 *      and closes the server.
 *   4. pollFlow(state) → if code arrived, exchanges it at
 *      https://auth.openai.com/oauth/token for access + refresh + id_token.
 *      Returns { tokens, expires_at }.
 *   5. refreshIfExpired(store, providerId) → re-exchanges refresh_token
 *      when the access token is within 60s of expiry.
 *
 * Constants are copied from the Codex CLI source (public, not a secret).
 * Override via env vars: OPENAI_OAUTH_CLIENT_ID, CHATGPT_CODEX_BASE_URL.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProviderStore } from '@mcp/store/provider-store.js';

// CLIENT_ID/AUTHORIZE_URL/TOKEN_URL/SCOPES exported so the declarative
// `spec.auth` (provider-engine specs/chatgpt.ts) is parity-tested against source.
export const OPENAI_CLIENT_ID = process.env.OPENAI_OAUTH_CLIENT_ID ?? 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_AUTH_HOST = 'https://auth.openai.com';
export const OPENAI_AUTHORIZE_URL = `${OPENAI_AUTH_HOST}/oauth/authorize`;
export const OPENAI_TOKEN_URL = `${OPENAI_AUTH_HOST}/oauth/token`;
const OPENAI_REDIRECT_PORT = 1455;
const OPENAI_REDIRECT_URI = `http://localhost:${OPENAI_REDIRECT_PORT}/auth/callback`;
export const OPENAI_SCOPES = 'openid profile email offline_access';

/**
 * Default Codex edge. Override with CHATGPT_CODEX_BASE_URL.
 * Inference actually hits `${base}/responses` — the Codex backend speaks
 * the Responses API, NOT /chat/completions. The current
 * OpenAIChatProvider uses chat.completions, so a dedicated Responses
 * adapter is still TODO; until then this provider can be connected and
 * will refresh tokens, but actual chat calls will 404.
 */
export const CHATGPT_CODEX_BASE_URL =
  process.env.CHATGPT_CODEX_BASE_URL ?? 'https://chatgpt.com/backend-api/codex';

/**
 * Fallback seed list used by the discovery pipeline when the live
 * `/models` call fails (network error, 5xx, timeout, missing creds).
 *
 * The Codex backend DOES expose `/models` to OAuth tokens (see
 * `src/apps/http-api/admin/model-discovery/chatgpt.ts` and the upstream
 * implementation in `codex-rs/model-provider/src/models_endpoint.rs`).
 * This array exists only so a flaky upstream doesn't leave the user
 * with an empty catalog after a refresh.
 */
export const CHATGPT_SEED_MODELS: {
  model_id: string;
  name: string;
  default_reasoning_level?: string;
  supported_reasoning_levels?: string[];
  apply_patch_tool_type?: string;
}[] = [
  // GPT-5.x families on the Codex Responses backend all accept the standard
  // four reasoning efforts. `xhigh` is gated per-model and is left to live
  // discovery to populate when the upstream `/models` call advertises it.
  { model_id: 'gpt-5.4',            name: 'GPT-5.4',
    default_reasoning_level: 'medium', supported_reasoning_levels: ['minimal', 'low', 'medium', 'high'] },
  { model_id: 'gpt-5.4-mini',       name: 'GPT-5.4 mini',
    default_reasoning_level: 'medium', supported_reasoning_levels: ['minimal', 'low', 'medium', 'high'] },
  { model_id: 'gpt-5.3-codex',      name: 'GPT-5.3 Codex',
    default_reasoning_level: 'medium', supported_reasoning_levels: ['minimal', 'low', 'medium', 'high'] },
  { model_id: 'gpt-5.2',            name: 'GPT-5.2',
    default_reasoning_level: 'medium', supported_reasoning_levels: ['minimal', 'low', 'medium', 'high'] },
  { model_id: 'gpt-5.2-codex',      name: 'GPT-5.2 Codex',
    default_reasoning_level: 'medium', supported_reasoning_levels: ['minimal', 'low', 'medium', 'high'] },
  { model_id: 'gpt-5.1-codex',      name: 'GPT-5.1 Codex',
    default_reasoning_level: 'medium', supported_reasoning_levels: ['minimal', 'low', 'medium', 'high'] },
  { model_id: 'gpt-5.1-codex-max',  name: 'GPT-5.1 Codex max',
    default_reasoning_level: 'medium', supported_reasoning_levels: ['minimal', 'low', 'medium', 'high'] },
  { model_id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex mini',
    default_reasoning_level: 'medium', supported_reasoning_levels: ['minimal', 'low', 'medium', 'high'] },
];

interface PendingFlow {
  code_verifier: string;
  state: string;
  server: Server;
  createdAt: number;
  /** Resolved by the callback handler when `code` arrives. */
  code?: string;
  error?: string;
}

// In-process map keyed by state. Only one flow should be active at a time
// (port 1455 can only be bound once), so the Map is mostly a way to plumb
// state between the two HTTP handlers.
const pending = new Map<string, PendingFlow>();
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkce(): { code_verifier: string; code_challenge: string } {
  const code_verifier = base64url(randomBytes(32));
  const code_challenge = base64url(createHash('sha256').update(code_verifier).digest());
  return { code_verifier, code_challenge };
}

function cleanupExpired(): void {
  const now = Date.now();
  for (const [state, flow] of pending) {
    if (now - flow.createdAt > FLOW_TIMEOUT_MS) {
      try {
        flow.server.close();
      } catch {
        /* ignore */
      }
      pending.delete(state);
    }
  }
}

export interface StartFlowResult {
  authorize_url: string;
  state: string;
}

/**
 * Start a new PKCE flow. Boots the loopback server on 127.0.0.1:1455 and
 * returns the authorize URL the UI should open in a new tab. Throws if the
 * port is already in use (another flow already running, or an external
 * process holding the port).
 */
export async function startOAuthFlow(): Promise<StartFlowResult> {
  cleanupExpired();
  // Abort any previous in-flight flow — port 1455 can only be bound once.
  for (const [s, f] of pending) {
    try {
      f.server.close();
    } catch {
      /* ignore */
    }
    pending.delete(s);
  }

  const { code_verifier, code_challenge } = generatePkce();
  const state = base64url(randomBytes(16));

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://localhost:${OPENAI_REDIRECT_PORT}`);
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
          '<html><body><h3>Invalid state</h3><p>You can close this tab.</p></body></html>'
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
          <h3>✅ Connected</h3>
          <p>You can close this tab and return to the dashboard.</p>
          <script>setTimeout(() => window.close(), 500);</script>
        </body></html>`
      );
      // Close the server shortly after responding — one-shot by design.
      setTimeout(() => {
        try {
          server.close();
        } catch {
          /* ignore */
        }
      }, 200);
    } catch (e) {
      res.writeHead(500).end((e as Error).message);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(OPENAI_REDIRECT_PORT, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr) {
        reject(new Error('failed to bind loopback server'));
        return;
      }
      resolve();
    });
  });

  pending.set(state, {
    code_verifier,
    state,
    server,
    createdAt: Date.now(),
  });

  // Extra params copied from opencode's Codex plugin — without
  // `id_token_add_organizations` + `codex_cli_simplified_flow` the token
  // exchange succeeds but the id_token is missing the chatgpt_account_id
  // claim the Codex backend validates on every request.
  const authorize_url =
    `${OPENAI_AUTHORIZE_URL}?` +
    new URLSearchParams({
      response_type: 'code',
      client_id: OPENAI_CLIENT_ID,
      redirect_uri: OPENAI_REDIRECT_URI,
      scope: OPENAI_SCOPES,
      state,
      code_challenge,
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
    }).toString();

  return { authorize_url, state };
}

/**
 * Exchange an authorization code (captured by the loopback server) for
 * access + refresh + id_token. Called by pollFlow() on the first poll that
 * sees `flow.code` populated.
 */
async function exchangeCode(code: string, codeVerifier: string): Promise<TokenResponse> {
  const r = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OPENAI_CLIENT_ID,
      code,
      redirect_uri: OPENAI_REDIRECT_URI,
      code_verifier: codeVerifier,
    }).toString(),
  });
  if (!r.ok) {
    throw new Error(`OpenAI token exchange failed: HTTP ${r.status} ${await r.text()}`);
  }
  return (await r.json()) as TokenResponse;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
}

export type PollFlowResult =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'error'; error: string }
  | {
      status: 'authorized';
      access_token: string;
      refresh_token: string | null;
      id_token: string | null;
      expires_at: number;
    };

/**
 * Called by the dashboard on an interval with the state it got from
 * startOAuthFlow. Returns `pending` until the loopback server captures
 * the code, then exchanges once and returns `authorized`.
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

  // We've got a code — exchange it and tear down the flow entry.
  try {
    const tok = await exchangeCode(flow.code, flow.code_verifier);
    pending.delete(state);
    const expires_in = tok.expires_in ?? 3600;
    return {
      status: 'authorized',
      access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? null,
      id_token: tok.id_token ?? null,
      expires_at: Date.now() + expires_in * 1000,
    };
  } catch (e) {
    pending.delete(state);
    return { status: 'error', error: (e as Error).message };
  }
}

/**
 * Headers to send on every Codex backend request. Authorization is set by
 * the OpenAI SDK from apiKey; the rest go via defaultHeaders.
 */
export function openaiAuthHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'codex-cli/0.1.0',
    'OpenAI-Beta': 'responses=experimental',
  };
}

/**
 * Refresh the stored access token when it's within 60s of expiry. Returns
 * the current valid token, or null if nothing is stored yet.
 */
export async function refreshIfExpired(
  store: ProviderStore,
  providerId: string
): Promise<string | null> {
  const tok = store.getOAuth(providerId);
  if (!tok) return null;

  const now = Date.now();
  const stillValid = tok.expires_at && tok.expires_at - now > 60_000;
  if (stillValid) return tok.access_token;

  if (!tok.refresh_token) {
    // No refresh token (shouldn't happen with offline_access scope, but
    // bail cleanly instead of exploding).
    return tok.access_token;
  }

  const r = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: OPENAI_CLIENT_ID,
      refresh_token: tok.refresh_token,
      scope: OPENAI_SCOPES,
    }).toString(),
  });
  if (!r.ok) {
    throw new Error(`OpenAI refresh failed: HTTP ${r.status} ${await r.text()}`);
  }
  const data = (await r.json()) as TokenResponse;
  const expires_in = data.expires_in ?? 3600;
  const expires_at = Date.now() + expires_in * 1000;
  store.setOAuth({
    provider_id: providerId,
    access_token: data.access_token,
    // OpenAI sometimes rotates refresh tokens; keep the old one if absent.
    refresh_token: data.refresh_token ?? tok.refresh_token,
    expires_at,
    scope: tok.scope,
    extra: { ...tok.extra, id_token: data.id_token ?? (tok.extra as { id_token?: string })?.id_token },
  });
  return data.access_token;
}
