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

export function recordAudit(
  c: Context<{ Bindings: Env }>,
  event: string,
  status: number,
  opts: { accountId?: string | null; [key: string]: unknown } = {},
): void {
  const ip = c.req.header('cf-connecting-ip') ?? null;
  const { accountId = null, ...meta } = opts; // everything except accountId is meta (redacted on write)
  const write = async () => {
    try {
      const log = createAuditLog(createD1Executor(c.env.DB), cryptoIdGen, systemClock);
      const e: AuditEvent = {
        event,
        status,
        accountId,
        ipHash: ip ? await hashPii(ip, c.env.IP_HASH_SALT ?? '') : null,
        meta,
      };
      await log.record(e);
    } catch (err) {
      console.error('[audit] write failed', { event, err: String(err) });
    }
  };
  // Don't block the response on the audit write.
  c.executionCtx.waitUntil(write());
}
