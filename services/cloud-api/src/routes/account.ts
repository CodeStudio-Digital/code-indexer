/**
 * Account lifecycle (GDPR/LGPD): data export + erasure. Both Bearer-protected;
 * delete additionally REAUTHS with the current password and a literal "DELETE"
 * confirmation. Export aggregates the user's data across every context. Erasure
 * is an immediate hard delete (FK cascade) — true right-to-erasure, no half-state.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { asAccountId, asSessionId } from '@cloudstudio/cloud-kernel';
import type { Env } from '../env.js';
import { createIdentityBundle } from '../composition.js';
import { createBillingBundle } from '../billing-composition.js';
import { createSharingBundle } from '../sharing-composition.js';
import { createFeedbackBundle } from '../feedback-composition.js';
import { createAccountAdmin, purgeAccountBlobs } from '../infra/account-admin.js';
import { createD1Executor } from '../infra/d1/d1-executor.js';
import { pbkdf2Hasher } from '../infra/pbkdf2-hasher.js';
import { requireClaims, unauthorized } from '../middleware/auth.js';
import { enforceRateLimit, HOUR } from '../middleware/rate-limit.js';
import { recordAudit } from '../middleware/audit.js';

const deleteSchema = z.object({ password: z.string().min(1).max(512), confirm: z.literal('DELETE') });

export function accountRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // GET /v1/account/export — the user's data across identity/billing/sharing/feedback.
  app.get('/export', async (c) => {
    const identity = createIdentityBundle(c.env);
    const claims = await requireClaims(c, identity);
    if (!claims) return unauthorized(c);
    const accountId = asAccountId(claims.sub);
    const account = await identity.accounts.findById(accountId);
    if (!account) return unauthorized(c);

    const [sessions, subscription, shares, feedback] = await Promise.all([
      identity.listSessions.execute({ accountId, currentSessionId: asSessionId(claims.sid) }),
      createBillingBundle(c.env).billing.getSubscription(accountId),
      createSharingBundle(c.env).list.execute({ ownerAccountId: accountId }),
      createFeedbackBundle(c.env).list.execute({ accountId }),
    ]);
    recordAudit(c, 'account_export', 200, { accountId });
    return c.json(
      {
        exportedAt: new Date().toISOString(),
        account: account.toPublic(),
        sessions: sessions.ok ? sessions.value : [],
        subscription,
        shares,
        feedback,
      },
      200,
    );
  });

  // DELETE /v1/account — reauth, then erase. The access token's session is wiped
  // by the cascade, so it stops working immediately.
  app.delete('/', async (c) => {
    const parsed = deleteSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ code: 'validation_failed', message: 'Type DELETE to confirm.' }, 400);
    const identity = createIdentityBundle(c.env);
    const claims = await requireClaims(c, identity);
    if (!claims) return unauthorized(c);
    const accountId = asAccountId(claims.sub);
    // Bound the password-reauth so a stolen access token can't become an
    // unlimited online password-guessing oracle (this path skips LoginThrottle).
    const limited = await enforceRateLimit(c, [{ key: `acctdelete:${accountId}`, limit: 10, windowMs: HOUR }]);
    if (limited) return limited;
    const account = await identity.accounts.findById(accountId);
    if (!account) return unauthorized(c);

    // Reauth with the current password (constant-ish: one verify against the real hash).
    const cred = await identity.accounts.findCredentialByCanonical(account.emailCanonical);
    if (!cred || !(await pbkdf2Hasher.verify(parsed.data.password, cred.passwordHash))) {
      recordAudit(c, 'account_delete_denied', 401, { accountId });
      return c.json({ code: 'invalid_credentials', message: 'Password is incorrect.' }, 401);
    }

    // Erase R2 blobs FIRST (a DB cascade can't touch them); if this throws we
    // return 500 and the account survives — better than orphaning the user's files.
    await purgeAccountBlobs(c.env.ASSETS, accountId);
    await createAccountAdmin(createD1Executor(c.env.DB)).hardDelete(accountId);
    recordAudit(c, 'account_deleted', 200, { accountId });
    return c.json({ deleted: true }, 200);
  });

  return app;
}
