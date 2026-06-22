/**
 * Hosted API docs routes. Publish/list/revoke are Bearer-protected and
 * entitlement-gated (apiDocs); the public viewer (`GET /d/:slug` HTML +
 * `GET /d/:slug/openapi.json`) takes NO auth. The publish use-case RE-REDACTS the
 * client spec server-side before signing + storing (the client strip is a UX pass
 * we never trust). The viewer page is the ONE HTML surface of this JSON API, so it
 * gets a relaxed-but-scoped CSP via `docsSecurityHeaders` (see index.ts).
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { asAccountId, toErrorBody } from '@cloudstudio/cloud-kernel';
import { docHttpStatus, isSlug, asSlug, type DocError, type DocSite, type TryItMode } from '@cloudstudio/cloud-sharing';
import type { Env } from '../env.js';
import { createIdentityBundle } from '../composition.js';
import { createDocsBundle } from '../docs-composition.js';
import { resolveEntitlements } from '../entitlements.js';
import { requireClaims, unauthorized, isVerified, emailNotVerified } from '../middleware/auth.js';
import { enforceRateLimit, HOUR } from '../middleware/rate-limit.js';
import { recordAudit } from '../middleware/audit.js';

const publishSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  spec: z.record(z.unknown()), // an OpenAPI document (object); the use-case re-validates + redacts
  visibility: z.enum(['public', 'unlisted']).default('unlisted'),
  tryItMode: z.enum(['off', 'local']).default('off'),
});

function respondDocError(c: Context<{ Bindings: Env }>, error: DocError) {
  return c.json(toErrorBody(error), docHttpStatus(error) as ContentfulStatusCode);
}

export function docsRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post('/', async (c) => {
    const parsed = publishSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ code: 'validation_failed', message: 'Invalid docs payload.', details: parsed.error.flatten() }, 400);
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    if (!isVerified(claims)) return emailNotVerified(c);
    // Publishing redacts + signs + stores a spec (CPU + storage) — cap per account.
    const limited = await enforceRateLimit(c, [{ key: `docs:acct:${claims.sub}`, limit: 30, windowMs: HOUR }]);
    if (limited) return limited;
    const docs = createDocsBundle(c.env);
    if (!docs.signerConfigured) return c.json({ code: 'docs_not_configured', message: 'Doc hosting is not configured.' }, 501);
    const accountId = asAccountId(claims.sub);
    const ent = await resolveEntitlements(c.env, claims.sub);
    const r = await docs.publish.execute({
      ownerAccountId: accountId,
      title: parsed.data.title,
      description: parsed.data.description,
      spec: parsed.data.spec,
      visibility: parsed.data.visibility,
      tryItMode: parsed.data.tryItMode,
      entitlement: { apiDocs: ent.features.apiDocs, maxApiDocs: ent.limits.maxApiDocs },
    });
    if (!r.ok) return respondDocError(c, r.error);
    recordAudit(c, 'doc_published', 201, { accountId, docId: r.value.docId, visibility: parsed.data.visibility });
    return c.json({ ...r.value, url: `${c.env.SHARE_BASE_URL}/d/${r.value.slug}` }, 201);
  });

  app.get('/', async (c) => {
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    const docs = await createDocsBundle(c.env).list.execute({ ownerAccountId: asAccountId(claims.sub) });
    return c.json({ docs: docs.map(toSummary), baseUrl: c.env.SHARE_BASE_URL }, 200);
  });

  app.delete('/:id', async (c) => {
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    if (!isVerified(claims)) return emailNotVerified(c); // revoke is a cloud WRITE (R3)
    const r = await createDocsBundle(c.env).revoke.execute({ docId: c.req.param('id'), ownerAccountId: asAccountId(claims.sub) });
    if (r.ok) recordAudit(c, 'doc_revoked', 200, { accountId: claims.sub, docId: c.req.param('id') });
    return r.ok ? c.json(r.value, 200) : respondDocError(c, r.error);
  });

  return app;
}

/** Public read-only viewer. NO auth. Mounted at top-level `/d`. Serves the
 *  Swagger-UI shell (HTML) + the raw redacted spec JSON. */
export function publicDocsRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/:slug/openapi.json', async (c) => {
    const slug = c.req.param('slug');
    if (!isSlug(slug)) return c.json(toErrorBody({ code: 'doc_not_found', message: 'Docs not found.' }), 404);
    const r = await createDocsBundle(c.env).getPublic.execute({ slug: asSlug(slug) });
    if (!r.ok) return respondDocError(c, r.error);
    // Serve the stored bytes verbatim (already redacted; matches the signature).
    return c.body(r.value.specJson, 200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' });
  });

  app.get('/:slug', async (c) => {
    const slug = c.req.param('slug');
    if (!isSlug(slug)) return c.html(notFoundHtml(), 404);
    const r = await createDocsBundle(c.env).getPublic.execute({ slug: asSlug(slug) });
    if (!r.ok) return c.html(notFoundHtml(), docHttpStatus(r.error) as ContentfulStatusCode);
    return c.html(viewerHtml(r.value.slug, r.value.title, r.value.tryItMode), 200, { 'cache-control': 'public, max-age=60' });
  });

  return app;
}

function toSummary(d: DocSite) {
  return {
    id: d.id,
    slug: d.slug,
    title: d.title,
    description: d.description,
    visibility: d.visibility,
    status: d.status,
    tryItMode: d.tryItMode,
    operationCount: d.operationCount,
    createdAtMs: d.createdAtMs,
  };
}

const SWAGGER_VERSION = '5.17.14';
const SWAGGER_BASE = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_VERSION}`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

/** Swagger-UI shell pointed at the same-origin spec. `tryItMode==='off'` disables
 *  the interactive "Try it out" by zeroing the supported submit methods. The slug
 *  is validated (`[0-9A-Za-z_-]{21}`) before reaching here, so it's URL-safe. */
function viewerHtml(slug: string, title: string, tryItMode: TryItMode): string {
  const submit = tryItMode === 'off' ? '[]' : "['get','put','post','delete','patch','options','head']";
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>${safeTitle} — API docs</title>
  <link rel="stylesheet" href="${SWAGGER_BASE}/swagger-ui.css" />
  <style>body{margin:0;background:#fafafa}</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${SWAGGER_BASE}/swagger-ui-bundle.js" crossorigin="anonymous"></script>
  <script>
    window.addEventListener('load', function () {
      window.ui = SwaggerUIBundle({
        url: '/d/${slug}/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        supportedSubmitMethods: ${submit},
        presets: [SwaggerUIBundle.presets.apis],
      });
    });
  </script>
</body>
</html>`;
}

function notFoundHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Not found</title></head><body style="font-family:system-ui;padding:3rem;text-align:center;color:#444"><h1>Docs not found</h1><p>This documentation link is invalid, revoked, or expired.</p></body></html>`;
}
