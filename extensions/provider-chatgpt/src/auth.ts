import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  AuthPollResult,
  AuthStartResult,
  ProviderAuthContext,
  ProviderResolveCredentialsContext,
  ResolvedCreds,
  StoredOAuth,
} from '@mcp/provider-sdk';

export const CHATGPT_CODEX_BASE_URL =
  process.env.CHATGPT_CODEX_BASE_URL ?? 'https://chatgpt.com/backend-api/codex';

const OPENAI_CLIENT_ID = process.env.OPENAI_OAUTH_CLIENT_ID ?? 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_SCOPES = 'openid profile email offline_access';
const OPENAI_REDIRECT_PORT = 1455;
const OPENAI_REDIRECT_URI = `http://localhost:${OPENAI_REDIRECT_PORT}/auth/callback`;
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
}

interface PendingFlow {
  code_verifier: string;
  state: string;
  server: Server;
  createdAt: number;
  code?: string;
  error?: string;
}

const pending = new Map<string, PendingFlow>();

export async function startChatGPTAuth(): Promise<AuthStartResult & { authorize_url: string }> {
  cleanupExpired();
  for (const [state, flow] of pending) {
    try {
      flow.server.close();
    } catch {
      /* ignore */
    }
    pending.delete(state);
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
      const flow = pending.get(qsState);
      if (!flow || qsState !== flow.state) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(
          '<html><body><h3>Invalid state</h3><p>You can close this tab.</p></body></html>',
        );
        return;
      }
      flow.error = url.searchParams.get('error') ?? undefined;
      flow.code = url.searchParams.get('code') ?? undefined;
      if (!flow.error && !flow.code) flow.error = 'no_code_or_error';
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(
        `<html><body style="font-family:sans-serif;padding:2rem">
          <h3>Connected</h3>
          <p>You can close this tab and return to the dashboard.</p>
          <script>setTimeout(() => window.close(), 500);</script>
        </body></html>`,
      );
      setTimeout(() => {
        try {
          server.close();
        } catch {
          /* ignore */
        }
      }, 200);
    } catch (err) {
      res.writeHead(500).end((err as Error).message);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(OPENAI_REDIRECT_PORT, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr) reject(new Error('failed to bind loopback server'));
      else resolve();
    });
  });

  pending.set(state, { code_verifier, state, server, createdAt: Date.now() });
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

  return { authorizeUrl: authorize_url, authorize_url, state };
}

export async function pollChatGPTAuth(
  ctx: ProviderAuthContext,
  state: unknown,
): Promise<
  AuthPollResult & {
    access_token?: string;
    refresh_token?: string | null;
    id_token?: string | null;
    expires_at?: number;
  }
> {
  const key = typeof state === 'string' ? state : readObjectString(state, 'state');
  if (!key) return { status: 'error', message: 'state required' };
  cleanupExpired();
  const flow = pending.get(key);
  if (!flow) return { status: 'expired' };
  if (flow.error) {
    pending.delete(key);
    return { status: 'error', message: flow.error };
  }
  if (!flow.code) return { status: 'pending' };

  try {
    const token = await exchangeCode(ctx, flow.code, flow.code_verifier);
    pending.delete(key);
    const expiresIn = token.expires_in ?? 3600;
    return {
      status: 'authorized',
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? null,
      id_token: token.id_token ?? null,
      expires_at: Date.now() + expiresIn * 1000,
    };
  } catch (err) {
    pending.delete(key);
    return { status: 'error', message: (err as Error).message };
  }
}

export async function logoutChatGPTAuth(ctx: ProviderAuthContext): Promise<void> {
  await ctx.credentials.clear();
}

export async function resolveChatGPTCredentials(
  ctx: ProviderResolveCredentialsContext,
): Promise<ResolvedCreds> {
  const { config, credentials, log } = ctx;
  let token = config.api_key ?? '';

  try {
    const fresh = await refreshIfExpired(ctx);
    if (fresh) {
      token = fresh;
      if (fresh !== config.api_key) {
        await credentials.mirrorApiKey(fresh);
      }
    }
  } catch (err) {
    log(`refresh failed: ${(err as Error).message}`);
  }

  const stored = await credentials.get();
  const idToken = typeof stored?.extra?.id_token === 'string' ? stored.extra.id_token : null;
  const accountId = extractAccountIdFromIdToken(idToken);

  return {
    apiKey: token,
    baseURL: (config.base_url ?? CHATGPT_CODEX_BASE_URL).replace(/\/$/, ''),
    extra: { accountId },
  };
}

async function exchangeCode(
  ctx: ProviderAuthContext,
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  const response = await ctx.fetch(OPENAI_TOKEN_URL, {
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
  if (!response.ok) {
    throw new Error(`OpenAI token exchange failed: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as TokenResponse;
}

async function refreshIfExpired(ctx: ProviderResolveCredentialsContext): Promise<string | null> {
  const tok = await ctx.credentials.get();
  if (!tok) return null;

  const now = Date.now();
  const stillValid = tok.expires_at && tok.expires_at - now > 60_000;
  if (stillValid) return tok.access_token;
  if (!tok.refresh_token) return tok.access_token;

  const response = await ctx.fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: OPENAI_CLIENT_ID,
      refresh_token: tok.refresh_token,
      scope: OPENAI_SCOPES,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`OpenAI refresh failed: HTTP ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as TokenResponse;
  const next = applyRefresh(tok, data);
  await ctx.credentials.set(next);
  return next.access_token;
}

function cleanupExpired(): void {
  const now = Date.now();
  for (const [state, flow] of pending) {
    if (now - flow.createdAt <= FLOW_TIMEOUT_MS) continue;
    try {
      flow.server.close();
    } catch {
      /* ignore */
    }
    pending.delete(state);
  }
}

function generatePkce(): { code_verifier: string; code_challenge: string } {
  const code_verifier = base64url(randomBytes(32));
  const code_challenge = base64url(createHash('sha256').update(code_verifier).digest());
  return { code_verifier, code_challenge };
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function applyRefresh(current: StoredOAuth, data: TokenResponse): StoredOAuth {
  const expiresIn = data.expires_in ?? 3600;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? current.refresh_token,
    expires_at: Date.now() + expiresIn * 1000,
    scope: current.scope,
    extra: {
      ...current.extra,
      id_token: data.id_token ?? current.extra?.id_token,
    },
  };
}

function readObjectString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const got = (value as Record<string, unknown>)[key];
  return typeof got === 'string' && got.length > 0 ? got : undefined;
}

function extractAccountIdFromIdToken(idToken: string | undefined | null): string | null {
  if (!idToken) return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as {
      chatgpt_account_id?: string;
      organizations?: Array<{ id: string }>;
      'https://api.openai.com/auth'?: { chatgpt_account_id?: string };
    };
    return (
      claims.chatgpt_account_id ??
      claims['https://api.openai.com/auth']?.chatgpt_account_id ??
      claims.organizations?.[0]?.id ??
      null
    );
  } catch {
    return null;
  }
}
