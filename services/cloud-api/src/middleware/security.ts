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

/**
 * Relaxed-but-scoped headers for the hosted-docs viewer (`/d/*`) — the ONE HTML
 * surface of this otherwise JSON-only API. It loads Swagger-UI from jsdelivr and
 * fetches the same-origin spec; the strict `default-src 'none'` would block all
 * of it. NOTE: the spec's DESCRIPTION fields (info/tags/operations) ARE rendered
 * as markdown→HTML by Swagger-UI (only example/parameter VALUES are shown as inert
 * text), so those author-controlled strings rely on Swagger-UI's built-in
 * sanitizer. Defense-in-depth already done upstream: the exporter only emits
 * http(s)/mailto link schemes and escapes label delimiters, and publish re-redacts
 * the spec. FOLLOW-UP hardening (separate task): pin Swagger-UI via SRI, replace
 * the inline bootstrap with a nonce so `'unsafe-inline'` can be dropped, and add a
 * server-side HTML sanitizer at publish time. Framing is still denied.
 */
export function docsSecurityHeaders(): MiddlewareHandler<{ Bindings: Env }> {
  const CDN = 'https://cdn.jsdelivr.net';
  return secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", CDN],
      styleSrc: ["'self'", "'unsafe-inline'", CDN],
      imgSrc: ["'self'", 'data:', CDN],
      fontSrc: ["'self'", CDN],
      connectSrc: ["'self'"],
      workerSrc: ["'self'", 'blob:'],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
    },
    referrerPolicy: 'no-referrer',
    xContentTypeOptions: 'nosniff',
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
