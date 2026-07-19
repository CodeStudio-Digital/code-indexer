import type { EmailServiceBinding } from './infra/email-sender.js';

/** Resource bindings are generated from wrangler.jsonc. Secrets and optional
 * local-dev overrides remain declared below because Wrangler cannot infer
 * secrets that have not been installed in a developer's account. */
type GeneratedResourceBindings = Pick<CloudflareBindings, 'DB' | 'CACHE' | 'ASSETS' | 'LOGIN_THROTTLE'>;

/** Cloudflare bindings + vars/secrets available to the Worker (grow per phase). */
export interface Env extends GeneratedResourceBindings {
  /** Generic fixed-window rate limiter (email/feedback abuse + cost guard).
   *  Absent ⇒ rate limiting is skipped (local dev before the binding is added). */
  RATE_LIMIT?: DurableObjectNamespace;
  /** Cloudflare Email Sending binding. Absent in local dev (console fallback);
   *  enable via `send_email` in wrangler.jsonc once the sender domain is onboarded. */
  EMAIL?: EmailServiceBinding;
  ENVIRONMENT: string;
  APP_BASE_URL: string;
  SHARE_BASE_URL: string;
  EMAIL_FROM: string;
  /** Dev-only opt-in (set ONLY in .dev.vars) to log email bodies to the console for
   *  local testing. Carries one-time tokens — MUST be absent in prod. */
  EMAIL_DEBUG_LOG_BODY?: string;
  /** HMAC secret for access-token signing. Local: .dev.vars; prod: `wrangler secret put`. */
  ACCESS_SIGNING_SECRET: string;
  /** Secret pepper for hashing PII (IP/email) so stored hashes aren't reversible.
   *  Local: .dev.vars; prod: `wrangler secret put`. Absent ⇒ weak (keyless) hashing. */
  IP_HASH_SALT?: string;
  /** Stripe — absent in local dev (billing routes 501 until set via `wrangler secret put`). */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** Public var: the Stripe Price id for the Pro plan. */
  STRIPE_PRO_PRICE_ID?: string;
  /** Public var: the Stripe Price id for the per-seat Teams plan. */
  STRIPE_TEAMS_PRICE_ID?: string;
  /** Ed25519 PKCS8 private key (base64) for signing share snapshots. Local:
   *  .dev.vars; prod: `wrangler secret put`. Absent ⇒ share creation returns 501. */
  SHARE_SIGNING_PRIVKEY?: string;
  /** Cloudflare Turnstile secret for anonymous feedback. Absent ⇒ anonymous
   *  feedback is disabled (authenticated feedback still works). */
  TURNSTILE_SECRET?: string;
  /** Comma-separated CORS origin allowlist (web share viewer / dashboard / account
   *  portal). The desktop app is not a browser origin. Absent ⇒ no cross-origin
   *  browser access. */
  ALLOWED_ORIGINS?: string;
  // ── OAuth (P7-B) — per-provider client credentials. A provider whose pair is
  //    unset returns 404 (fail-soft, like Stripe/Turnstile). Set via `wrangler
  //    secret put`; locally via .dev.vars.
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  MS_OAUTH_CLIENT_ID?: string;
  MS_OAUTH_CLIENT_SECRET?: string;
  /** Azure tenant for Microsoft OAuth (default 'common'). */
  MS_OAUTH_TENANT?: string;
  /** HMAC secret signing the OAuth `state` (CSRF + PKCE-verifier carrier). Absent
   *  ⇒ OAuth routes 404. */
  OAUTH_STATE_SECRET?: string;
  /** Public base URL the provider redirects back to (this worker). Defaults to
   *  APP_BASE_URL. Must match the redirect URI registered in each provider console. */
  OAUTH_PUBLIC_BASE_URL?: string;
  /** Web portal base URL (Cloudflare Pages) for the `flow=portal` handoff. */
  PORTAL_BASE_URL?: string;
  /** Platform-operator bearer token for the /v1/admin surface (sales-led Enterprise
   *  grants). Absent/short ⇒ the admin router 404s (fail-soft). Set via
   *  `wrangler secret put ADMIN_API_TOKEN`. This is an OPS token, not a user role. */
  ADMIN_API_TOKEN?: string;
  /** Passphrase used to encrypt per-org OIDC SSO client secrets at rest (AES-GCM,
   *  key = SHA-256 of this). Absent ⇒ org SSO config/login 404s (fail-soft). Set via
   *  `wrangler secret put SSO_CONFIG_KEY`. Rotating it invalidates stored secrets. */
  SSO_CONFIG_KEY?: string;
  // ── Optional managed GitHub App identity. The OAuth client and RSA private
  //    JWK belong to the GitHub App itself (not the separate sign-in provider).
  //    All secrets are configured with `wrangler secret put`.
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  /** JSON-encoded private RSA JWK imported by Web Crypto. Never expose this to
   *  Electron, the renderer, a Git remote, command args, or logs. */
  GITHUB_APP_PRIVATE_KEY_JWK?: string;
  /** Dedicated HMAC secret for install/authorize state; falls back to the
   *  existing OAuth state secret when omitted. */
  GITHUB_APP_STATE_SECRET?: string;
  /** One configured GitHub host per App. Enterprise hosts need their own App and
   *  endpoint; native project credentials remain the default for every host. */
  GITHUB_APP_HOST?: string;
  GITHUB_APP_WEB_URL?: string;
  GITHUB_APP_API_URL?: string;
}
