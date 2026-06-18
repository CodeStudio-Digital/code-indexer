/**
 * Append-only security audit. Records sensitive actions (login, signup, reset,
 * 2FA, share create/revoke, account delete, webhook) into D1. PII-safe: stores
 * only a salted ip_hash + account id; `meta` is redacted to primitive scalars and
 * any secret-ish key is dropped. The table has triggers blocking UPDATE/DELETE,
 * so the trail is immutable (the account_id has NO FK → it survives erasure).
 */
import type { Clock, DbExecutor, IdGen } from '@cloudstudio/cloud-kernel';

export interface AuditEvent {
  event: string;
  accountId?: string | null;
  ipHash?: string | null;
  status: number;
  meta?: Record<string, unknown>;
}

export interface AuditLog {
  record(e: AuditEvent): Promise<void>;
}

export function createAuditLog(db: DbExecutor, ids: IdGen, clock: Clock): AuditLog {
  return {
    async record(e) {
      await db.run(
        'INSERT INTO audit_log (id, ts_ms, event, account_id, ip_hash, status, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [ids.uuid(), clock.now(), e.event, e.accountId ?? null, e.ipHash ?? null, e.status, JSON.stringify(redactMeta(e.meta ?? {}))],
      );
    },
  };
}

const SECRET_KEY = /pass|pwd|secret|token|hash|authorization|cookie|key|credential/i;

/** Keep only primitive scalars whose key is not secret-ish — never log a
 *  password, token, hash, or nested object that might carry one. */
export function redactMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SECRET_KEY.test(k)) continue;
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      out[k] = typeof v === 'string' ? v.slice(0, 256) : v;
    }
  }
  return out;
}
