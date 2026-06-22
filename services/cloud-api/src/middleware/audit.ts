/**
 * `recordAudit(c, ...)` — fire-and-forget audit from a route handler. Resolves
 * the actor (account id from claims if present) + salted ip_hash, then writes via
 * `executionCtx.waitUntil` so a slow/failed audit write never blocks or fails the
 * user-facing response. Audit failure is swallowed (logged), never surfaced.
 */
import type { Context } from 'hono';
import { createD1Executor } from '../infra/d1/d1-executor.js';
import { createAuditLog, type AuditEvent } from '../infra/audit.js';
import { cryptoIdGen, systemClock } from '../infra/runtime.js';
import { hashPii } from '../infra/sha256.js';
import type { Env } from '../env.js';

async function writeAudit(
  c: Context<{ Bindings: Env }>,
  event: string,
  status: number,
  opts: { accountId?: string | null; [key: string]: unknown },
): Promise<void> {
  const ip = c.req.header('cf-connecting-ip') ?? null;
  // accountId + orgId become columns; everything else is meta (redacted on write).
  const { accountId = null, orgId = null, ...meta } = opts as { accountId?: string | null; orgId?: string | null; [k: string]: unknown };
  try {
    const log = createAuditLog(createD1Executor(c.env.DB), cryptoIdGen, systemClock);
    const e: AuditEvent = {
      event,
      status,
      accountId,
      orgId,
      ipHash: ip ? await hashPii(ip, c.env.IP_HASH_SALT ?? '') : null,
      meta,
    };
    await log.record(e);
  } catch (err) {
    console.error('[audit] write failed', { event, err: String(err) });
  }
}

/** Fire-and-forget audit (most events): never blocks/fails the response. */
export function recordAudit(
  c: Context<{ Bindings: Env }>,
  event: string,
  status: number,
  opts: { accountId?: string | null; [key: string]: unknown } = {},
): void {
  c.executionCtx.waitUntil(writeAudit(c, event, status, opts));
}

/** Awaited audit for compliance-critical events (e.g. account deletion) — the
 *  trail must be persisted before we return success. Still swallows errors so a
 *  transient audit failure can't block the user's right-to-erasure. */
export async function recordAuditNow(
  c: Context<{ Bindings: Env }>,
  event: string,
  status: number,
  opts: { accountId?: string | null; [key: string]: unknown } = {},
): Promise<void> {
  await writeAudit(c, event, status, opts);
}
