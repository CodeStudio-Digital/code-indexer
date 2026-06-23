/**
 * The OAuth host-capability contract — what a plugin OAuth provider authors
 * against instead of per-provider core code.
 *
 * A provider declares HOW it connects (`AuthDescriptor`, declarative) and
 * implements the imperative steps (`ProviderAuthHandlers`) using host-provided
 * primitives (`OAuthHostCapabilities`: pkce / loopback / device-code / open
 * browser) and a per-provider credential store (`ProviderCredentials`, backed
 * by the `oauth_tokens` table). The host owns the chrome (generic connect
 * dialog, polling cadence, loopback ports, scheduled refresh); the plugin owns
 * the network steps. This is the contract; the runtime host implementation +
 * generic routes are wired in the http-api admin layer.
 */
import type { ResolvedCreds, ProviderConfigLike } from './credentials.js';

/** PKCE pair (RFC 7636, S256). */
export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** Stored OAuth token set — mirrors an `oauth_tokens` row. */
export interface StoredOAuth {
  access_token: string;
  refresh_token?: string | null;
  /** Absolute expiry, ms epoch. */
  expires_at?: number | null;
  scope?: string | null;
  extra?: Record<string, unknown>;
}

/** A declarative form field the core renders for an `api-key` connect flow. */
export interface AuthField {
  /** Stored under this key (e.g. 'apiKey', 'baseURL', 'accountId'). */
  key: string;
  label: string;
  secret?: boolean;
  optional?: boolean;
  placeholder?: string;
}

/**
 * Declarative description of how a user connects this provider. The host reads
 * it to pick the connect surface and pre-grant the needed capabilities — no
 * plugin code runs to render it.
 */
export interface AuthDescriptor {
  /** Credential class. */
  mode: 'api-key' | 'oauth' | 'aws-sigv4';
  /**
   * OAuth shape (oauth only): `authorization-code` (Codex/Google loopback+PKCE),
   * `device-code` (Kimi), `pat-exchange` (Copilot: GitHub PAT → editor token).
   */
  flavor?: 'authorization-code' | 'device-code' | 'pat-exchange';
  scopes?: string[];
  /** Refresh this many seconds before `expires_at` (default: host policy). */
  refreshThresholdSec?: number;
  /** Fields the core renders for `mode: 'api-key'` (no plugin UI). */
  fields?: AuthField[];
  /** Host capabilities this flow needs, so the host can pre-arrange them. */
  needs?: {
    loopback?: boolean;
    deviceCode?: boolean;
    openBrowser?: boolean;
    scheduledRefresh?: boolean;
  };

  // ── generic-flow driver fields (so the host OAuth engine runs the standard
  //    80–90% with no code; a third-party RFC provider sets only these) ──
  /** Public OAuth client id. */
  clientId?: string;
  /** Public client secret (e.g. gemini-cli's, Apache-2.0). */
  clientSecret?: string;
  /** Authorize endpoint (loopback/authorization-code). */
  authorizeUrl?: string;
  /** Authorize endpoint chosen by which scope set was requested (claude.ai vs console). */
  authorizeUrlByScope?: Array<{ whenScope: string; url: string }>;
  /** Token endpoint (code exchange + refresh). */
  tokenUrl?: string;
  /** Device-authorization endpoint (device-code flow). */
  deviceAuthUrl?: string;
  /** Loopback redirect binding for authorization-code flows. */
  redirect?: { port?: number; path?: string };
  /** Extra query params appended to the authorize URL (e.g. id_token_add_organizations). */
  authorizeParams?: Record<string, string>;
  /**
   * Names a HOST-shipped exotic-hook module (keyed by provider kind) for the
   * imperative remainder a declarative descriptor can't express — PAT-exchange,
   * account-id-from-JWT, project-id resolution, profile/managed-key, the kimi
   * tombstone, claude-code bearer dispatch. Third-party plugins CANNOT set
   * hooks; they get the pure-declarative flow only.
   */
  hooks?: string;
}

/** Per-provider credential store, backed by the `oauth_tokens` table. */
export interface ProviderCredentials {
  get(): Promise<StoredOAuth | null>;
  set(tokens: StoredOAuth): Promise<void>;
  /**
   * Mirror the access token into `provider_configs.api_key` — the OpenAI-compat
   * fallback path some adapters read. Source of truth stays `oauth_tokens`.
   */
  mirrorApiKey(token: string): Promise<void>;
  clear(): Promise<void>;
}

/** A bound loopback redirect server awaiting the OAuth callback. */
export interface LoopbackBinding {
  /** The `redirect_uri` to put in the authorize URL (e.g. http://localhost:1455/cb). */
  redirectUri: string;
  /** Resolves when the browser hits the redirect; rejects on timeout. */
  waitForCode(): Promise<{ code: string; state: string }>;
  /** Stop the server (idempotent). */
  close(): void;
}

/** An in-flight RFC-8628 device-code flow. */
export interface DeviceCodeFlow {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  /** Poll interval, seconds. */
  interval: number;
  /** Absolute expiry, ms epoch. */
  expiresAt: number;
  /** Poll once for authorization. */
  poll(): Promise<{ status: 'pending' | 'authorized' | 'expired'; tokens?: StoredOAuth }>;
}

/**
 * Host-provided OAuth primitives. A plugin uses these instead of re-implementing
 * loopback servers / PKCE / device flows per provider.
 */
export interface OAuthHostCapabilities {
  /** Generate a fresh PKCE pair (S256). */
  pkce(): PkcePair;
  /** Host-keyed CSRF state value (HMAC), verifiable on callback. */
  stateHmac(payload?: string): string;
  /** Bind a loopback server on an ephemeral (or declared) port for the redirect. */
  loopback(opts?: { port?: number; path?: string; timeoutMs?: number }): Promise<LoopbackBinding>;
  /** Open the system browser (Electron `shell.openExternal`). */
  openBrowser(url: string): Promise<void>;
  /** Start a device-code flow; returns the flow with a `poll()`. */
  deviceCode(opts: {
    startUrl: string;
    clientId: string;
    scope?: string;
    headers?: Record<string, string>;
  }): Promise<DeviceCodeFlow>;
}

/** Context handed to a provider's auth handlers. */
export interface ProviderAuthContext {
  /** The provider instance row being connected/refreshed. */
  config: ProviderConfigLike;
  fetch: typeof fetch;
  credentials: ProviderCredentials;
  oauth: OAuthHostCapabilities;
  /** Arm a host timer to call `refresh` at `atMs` (ms epoch). */
  scheduleRefresh(atMs: number): void;
  log(message: string): void;
}

export interface AuthStartResult {
  /** device-code: the user-facing code + verification URL. */
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  /** loopback / authorization-code: the authorize URL the host opens. */
  authorizeUrl?: string;
  /** Opaque state the host echoes back to `poll`. */
  state?: unknown;
  /** device-code poll interval, seconds. */
  interval?: number;
}

export interface AuthPollResult {
  status: 'pending' | 'authorized' | 'expired' | 'error';
  message?: string;
}

/**
 * Imperative auth handlers a provider plugin implements — only the ones its
 * `flavor` needs. `refresh` is the per-request resolver (the plugin's port of
 * today's `resolve*Creds`); it runs in the trusted in-process context.
 */
export interface ProviderAuthHandlers {
  /** Begin the connect flow (device authorization / build the authorize URL). */
  start?(ctx: ProviderAuthContext, input?: unknown): Promise<AuthStartResult>;
  /** Await/poll completion; persist tokens via `ctx.credentials` on success. */
  poll?(ctx: ProviderAuthContext, state: unknown): Promise<AuthPollResult>;
  /** Resolve runtime creds, refreshing tokens near expiry. */
  refresh?(ctx: ProviderAuthContext): Promise<ResolvedCreds>;
  /** Revoke + clear stored credentials. */
  logout?(ctx: ProviderAuthContext): Promise<void>;
}
