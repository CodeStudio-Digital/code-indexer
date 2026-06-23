/**
 * Personal-sync routes. Both Bearer-protected and entitlement-gated (`sync`):
 *  - POST /v1/sync/push — upload changed documents; server reconciles (LWW) and
 *    returns per-doc status (applied|noop|conflict) + the new feed cursor.
 *  - POST /v1/sync/pull — download everything past the client's cursor.
 * The client strips secret ENV VALUES before pushing (structure-only sync); the
 * server never receives or stores secrets. Both are JSON.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../env.js';
import { createIdentityBundle } from '../composition.js';
import { createSyncBundle } from '../sync-composition.js';
import { resolveEntitlements } from '../entitlements.js';
import { requireClaims, unauthorized, isVerified, emailNotVerified } from '../middleware/auth.js';
import { enforceRateLimit, HOUR } from '../middleware/rate-limit.js';
import { SYNC_KINDS, VAULT_KINDS, type SyncKind } from '../sync/types.js';

type Entitlements = Awaited<ReturnType<typeof resolveEntitlements>>;

const kindSchema = z.enum([
  'collection',
  'environment',
  'memory',
  'note',
  'project',
  'ssh_host',
  'ssh_identity',
  'vault_meta',
]);

/** Per-record cap (~64KB) so a vault ciphertext batch can't abuse the 4MB body limit. */
const MAX_BODY_BYTES = 64 * 1024;

const pushItemSchema = z
  .object({
    kind: kindSchema,
    clientDocId: z.string().min(1).max(128),
    baseVersion: z.number().int().nonnegative().default(0),
    updatedAtMs: z.number().int().nonnegative(),
    deleted: z.boolean().optional(),
    body: z.unknown().optional(),
  })
  .refine((d) => d.body === undefined || JSON.stringify(d.body).length <= MAX_BODY_BYTES, {
    message: `body exceeds ${MAX_BODY_BYTES} bytes`,
  });

const isVaultKind = (k: SyncKind): boolean => (VAULT_KINDS as readonly string[]).includes(k);

/**
 * Gate a set of kinds: vault kinds need `sshVault`, everything else needs `sync`.
 * Returns the failing entitlement code, or null when allowed.
 */
function gateKinds(ent: Entitlements, kinds: readonly SyncKind[]): 'ssh_vault' | 'sync' | null {
  const hasVault = kinds.some(isVaultKind);
  const hasPlain = kinds.some((k) => !isVaultKind(k));
  if (hasVault && !ent.features.sshVault) return 'ssh_vault';
  if (hasPlain && !ent.features.sync) return 'sync';
  return null;
}
const pushSchema = z.object({ documents: z.array(pushItemSchema).max(500) });
const pullSchema = z.object({
  kinds: z.array(kindSchema).nonempty().optional(),
  sinceVersion: z.number().int().nonnegative().default(0),
});

function notEntitled(c: Context<{ Bindings: Env }>, kind: 'ssh_vault' | 'sync') {
  return kind === 'ssh_vault'
    ? c.json({ code: 'ssh_vault_not_entitled', message: 'The encrypted SSH vault requires a Pro plan.' }, 402)
    : c.json({ code: 'sync_not_entitled', message: 'Cloud sync requires an active subscription or trial.' }, 402);
}

export function syncRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post('/push', async (c) => {
    const parsed = pushSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ code: 'validation_failed', message: 'Invalid push payload.', details: parsed.error.flatten() }, 400);
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    if (!isVerified(claims)) return emailNotVerified(c);
    const limited = await enforceRateLimit(c, [{ key: `sync:acct:${claims.sub}`, limit: 240, windowMs: HOUR }]);
    if (limited) return limited;
    const bundle = createSyncBundle(c.env, claims.sub);
    const ent = await resolveEntitlements(c.env, claims.sub);
    const gate = gateKinds(ent, parsed.data.documents.map((d) => d.kind));
    if (gate) return notEntitled(c, gate);
    const out = await bundle.service.push(parsed.data.documents);
    return c.json(out, 200);
  });

  app.post('/pull', async (c) => {
    const parsed = pullSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ code: 'validation_failed', message: 'Invalid pull payload.', details: parsed.error.flatten() }, 400);
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    const bundle = createSyncBundle(c.env, claims.sub);
    const ent = await resolveEntitlements(c.env, claims.sub);
    const kinds = parsed.data.kinds ?? SYNC_KINDS;
    const gate = gateKinds(ent, kinds);
    if (gate) return notEntitled(c, gate);
    const out = await bundle.service.pull(kinds, parsed.data.sinceVersion);
    return c.json(out, 200);
  });

  return app;
}
