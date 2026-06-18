/**
 * Cross-cutting edge security: strict headers on every response + an origin
 * allowlist for CORS. The API is JSON-only, so `default-src 'none'` is correct
 * (nothing is ever loaded from it). The desktop app is not a browser origin and
 * doesn't enforce CORS; the allowlist matters for the (future) web share viewer
 * and dashboard. Origins come from `ALLOWED_ORIGINS` (comma-separated) — the
 * Stripe webhook + public viewer are unaffected (server-to-server / GET).
 */
import { secureHeaders } from 'hono/secure-headers';
import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env.js';

export function securityHeaders(): MiddlewareHandler<{ Bindings: Env }> {
  return secureHeaders({
    contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] },
    referrerPolicy: 'no-referrer',
    xFrameOptions: 'DENY',
    xContentTypeOptions: 'nosniff',
    crossOriginResourcePolicy: 'same-site',
    strictTransportSecurity: 'max-age=31536000; includeSubDomains',
  });
}

export function corsAllowlist(): MiddlewareHandler<{ Bindings: Env }> {
  return cors({
    origin: (origin, c) => {
      const raw = (c.env as Env).ALLOWED_ORIGINS ?? '';
      const allowed = raw.split(',').map((o: string) => o.trim()).filter(Boolean);
      return allowed.includes(origin) ? origin : null; // echo only allowlisted origins; never '*'
    },
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['authorization', 'content-type', 'cf-turnstile-response'],
    maxAge: 600,
    credentials: false, // bearer-only API; no cookies ⇒ no CSRF surface
  });
}
