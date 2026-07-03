import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { arch, platform } from 'node:os';
import type {
  AuthPollResult,
  AuthStartResult,
  ProviderAuthContext,
  ProviderResolveCredentialsContext,
  ResolvedCreds,
  StoredOAuth,
} from '@mcp/provider-sdk';

const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_OAUTH_CLIENT_ID ??
  '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET =
  process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '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';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_REDIRECT_PORT = 1456;
const GOOGLE_REDIRECT_URI = `http://localhost:${GOOGLE_REDIRECT_PORT}/auth/callback`;
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;
const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const CODE_ASSIST_VERSION = 'v1internal';
const GEMINI_CLI_VERSION = '0.42.0';

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
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

export async function startGoogleOAuth(): Promise<AuthStartResult & { authorize_url: string }> {
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
      const url = new URL(req.url ?? '/', `http://localhost:${GOOGLE_REDIRECT_PORT}`);
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
          <h3>Connected to Google</h3>
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
    server.listen(GOOGLE_REDIRECT_PORT, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr) reject(new Error('failed to bind loopback server'));
      else resolve();
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
      access_type: 'offline',
      prompt: 'consent',
    }).toString();

  return { authorizeUrl: authorize_url, authorize_url, state };
}

export async function pollGoogleOAuth(
  ctx: ProviderAuthContext,
  state: unknown,
): Promise<
  AuthPollResult & {
    access_token?: string;
    refresh_token?: string | null;
    expires_at?: number;
    scope?: string;
    project_id?: string;
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
    let projectId = '';
    try {
      projectId = await setupCloudCode(ctx, token.access_token);
    } catch (err) {
      ctx.log(`CloudCode setup failed: ${(err as Error).message}`);
    }
    return {
      status: 'authorized',
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? null,
      expires_at: Date.now() + expiresIn * 1000,
      scope: token.scope ?? GOOGLE_SCOPES,
      project_id: projectId,
    };
  } catch (err) {
    pending.delete(key);
    return { status: 'error', message: (err as Error).message };
  }
}

export async function logoutGoogleOAuth(ctx: ProviderAuthContext): Promise<void> {
  await ctx.credentials.clear();
}

export async function resolveGoogleOAuthCredentials(
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
  return {
    apiKey: token || undefined,
    extra: {
      refreshToken: stored?.refresh_token,
      projectId: readString(stored?.extra?.projectId),
    },
  };
}

async function exchangeCode(
  ctx: ProviderAuthContext,
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  const response = await ctx.fetch(GOOGLE_TOKEN_URL, {
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
  if (!response.ok) {
    throw new Error(`Google token exchange failed: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as TokenResponse;
}

async function setupCloudCode(ctx: ProviderAuthContext, accessToken: string): Promise<string> {
  const response = await ctx.fetch(`${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_VERSION}:loadCodeAssist`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': `GeminiCLI/${GEMINI_CLI_VERSION}/unknown (${platform()}; ${arch()}; terminal)`,
    },
    body: JSON.stringify({
      metadata: {
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`CloudCode setup failed: HTTP ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as { cloudaicompanionProject?: string };
  return data.cloudaicompanionProject ?? '';
}

async function refreshIfExpired(ctx: ProviderResolveCredentialsContext): Promise<string | null> {
  const tok = await ctx.credentials.get();
  if (!tok) return null;

  const now = Date.now();
  const stillValid = tok.expires_at && tok.expires_at - now > 60_000;
  if (stillValid) return tok.access_token;
  if (!tok.refresh_token) return tok.access_token;

  const response = await ctx.fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: tok.refresh_token,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Google token refresh failed: HTTP ${response.status} ${await response.text()}`);
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
    scope: data.scope ?? current.scope,
    extra: current.extra ?? {},
  };
}

function readObjectString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const got = (value as Record<string, unknown>)[key];
  return typeof got === 'string' && got.length > 0 ? got : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
