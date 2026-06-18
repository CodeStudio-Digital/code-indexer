import type { EmailServiceBinding } from './infra/email-sender.js';

/** Cloudflare bindings + vars/secrets available to the Worker (grow per phase). */
export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ASSETS: R2Bucket;
  LOGIN_THROTTLE: DurableObjectNamespace;
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
  /** Ed25519 PKCS8 private key (base64) for signing share snapshots. Local:
   *  .dev.vars; prod: `wrangler secret put`. Absent ⇒ share creation returns 501. */
  SHARE_SIGNING_PRIVKEY?: string;
  /** Cloudflare Turnstile secret for anonymous feedback. Absent ⇒ anonymous
   *  feedback is disabled (authenticated feedback still works). */
  TURNSTILE_SECRET?: string;
  /** Comma-separated CORS origin allowlist (web share viewer / dashboard). The
   *  desktop app is not a browser origin. Absent ⇒ no cross-origin browser access. */
  ALLOWED_ORIGINS?: string;
}
