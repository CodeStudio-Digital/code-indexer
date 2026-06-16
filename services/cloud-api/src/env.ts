import type { EmailServiceBinding } from './infra/email-sender.js';

/** Cloudflare bindings + vars/secrets available to the Worker (grow per phase). */
export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ASSETS: R2Bucket;
  LOGIN_THROTTLE: DurableObjectNamespace;
  /** Cloudflare Email Sending binding. Absent in local dev (console fallback);
   *  enable via `send_email` in wrangler.jsonc once the sender domain is onboarded. */
  EMAIL?: EmailServiceBinding;
  ENVIRONMENT: string;
  APP_BASE_URL: string;
  SHARE_BASE_URL: string;
  EMAIL_FROM: string;
  /** HMAC secret for access-token signing. Local: .dev.vars; prod: `wrangler secret put`. */
  ACCESS_SIGNING_SECRET: string;
  /** Stripe — absent in local dev (billing routes 501 until set via `wrangler secret put`). */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** Public var: the Stripe Price id for the Pro plan. */
  STRIPE_PRO_PRICE_ID?: string;
  /** Ed25519 PKCS8 private key (base64) for signing share snapshots. Local:
   *  .dev.vars; prod: `wrangler secret put`. Absent ⇒ share creation returns 501. */
  SHARE_SIGNING_PRIVKEY?: string;
}
