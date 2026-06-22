/**
 * Backup routes (all Bearer-protected + entitlement-gated on `backup`):
 *  - POST   /v1/backups          — upload a gz bundle (raw binary body; label +
 *                                   manifest in headers). Stores in R2, indexes in
 *                                   D1, prunes per the tier's retention.
 *  - GET    /v1/backups          — list own backups (metadata only).
 *  - GET    /v1/backups/:id/blob — download the gz bundle (owner-guarded).
 *  - DELETE /v1/backups/:id      — delete (R2 object + row).
 * The blob is opaque to the server (the client's gzipped METADATA bundle — never
 * source). Upload/download are binary, so they live OUTSIDE the JSON CloudContract
 * (the client uses a dedicated binary transport).
 */
import { Hono, type Context } from 'hono';
import type { Env } from '../env.js';
import { createIdentityBundle } from '../composition.js';
import { createBackupBundle } from '../backups-composition.js';
import { resolveEntitlements } from '../entitlements.js';
import { requireClaims, unauthorized, isVerified, emailNotVerified } from '../middleware/auth.js';
import { enforceRateLimit, HOUR } from '../middleware/rate-limit.js';
import { recordAudit } from '../middleware/audit.js';
import { sha256HexBytes } from '../infra/hash.js';

const MAX_LABEL = 200;

function notEntitled(c: Context<{ Bindings: Env }>) {
  return c.json({ code: 'backup_not_entitled', message: 'Cloud backups require an active subscription or trial.' }, 402);
}

function parseManifest(header: string | undefined): Record<string, unknown> {
  if (!header) return {};
  try {
    return JSON.parse(atob(header)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function backupsRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post('/', async (c) => {
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    if (!isVerified(claims)) return emailNotVerified(c);
    const limited = await enforceRateLimit(c, [{ key: `backup:acct:${claims.sub}`, limit: 60, windowMs: HOUR }]);
    if (limited) return limited;
    const bundle = createBackupBundle(c.env);
    const ent = await resolveEntitlements(c.env, claims.sub);
    if (!ent.features.backup) return notEntitled(c);

    const blob = await c.req.arrayBuffer();
    if (!blob.byteLength) return c.json({ code: 'validation_failed', message: 'Empty backup body.' }, 400);
    const label = (c.req.header('x-backup-label') ?? '').slice(0, MAX_LABEL);
    const manifest = parseManifest(c.req.header('x-backup-manifest'));
    const contentSha256 = await sha256HexBytes(blob);
    const out = await bundle.service.create({ accountId: claims.sub, tier: ent.tier, blob, contentSha256, label, manifest });
    recordAudit(c, 'backup_created', 201, { accountId: claims.sub, backupId: out.id, byteSize: out.byteSize, pruned: out.prunedCount });
    return c.json(out, 201);
  });

  app.get('/', async (c) => {
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    const bundle = createBackupBundle(c.env);
    const ent = await resolveEntitlements(c.env, claims.sub);
    if (!ent.features.backup) return notEntitled(c);
    const backups = await bundle.service.list(claims.sub);
    return c.json({ backups: backups.map(toSummary) }, 200);
  });

  app.get('/:id/blob', async (c) => {
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    const bundle = createBackupBundle(c.env);
    const ent = await resolveEntitlements(c.env, claims.sub);
    if (!ent.features.backup) return notEntitled(c);
    const r = await bundle.service.download(claims.sub, c.req.param('id'));
    if (!r) return c.json({ code: 'backup_not_found', message: 'Backup not found.' }, 404);
    return c.body(r.blob, 200, {
      'content-type': 'application/gzip',
      'content-disposition': `attachment; filename="${r.meta.id}.gz"`,
      'x-backup-sha256': r.meta.contentSha256,
    });
  });

  app.delete('/:id', async (c) => {
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    if (!isVerified(claims)) return emailNotVerified(c); // deleting a backup is a cloud WRITE (R3)
    const ok = await createBackupBundle(c.env).service.remove(claims.sub, c.req.param('id'));
    if (!ok) return c.json({ code: 'backup_not_found', message: 'Backup not found.' }, 404);
    recordAudit(c, 'backup_deleted', 200, { accountId: claims.sub, backupId: c.req.param('id') });
    return c.json({ deleted: true }, 200);
  });

  return app;
}

function toSummary(m: { id: string; label: string; byteSize: number; manifest: Record<string, unknown>; createdAtMs: number; expiresAtMs: number | null }) {
  return { id: m.id, label: m.label, byteSize: m.byteSize, manifest: m.manifest, createdAtMs: m.createdAtMs, expiresAtMs: m.expiresAtMs };
}
