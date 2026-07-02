/**
 * CompanyServiceTransitionsStore — append-only audit trail of sandbox
 * service state flips (migration 188, company B1).
 *
 * One row per status/health transition of a `(session_id, service_id)`
 * service. `kind` says WHICH state machine flipped ('status' = the
 * container lifecycle in company_sandbox_services.status, 'health' = the
 * supervisor probe verdict). `actor` records who caused it (e.g.
 * 'supervisor', 'user', 'reaper', 'agent').
 *
 * No FK to company_sandbox_services on purpose: service rows get
 * destroyed and re-provisioned under the same service_id, and the audit
 * trail must survive that. Cleanup is explicit via `purgeSession`.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export type ServiceTransitionKind = 'status' | 'health';

export interface ServiceTransitionRow {
  id: number;
  sessionId: number;
  serviceId: string;
  kind: ServiceTransitionKind;
  fromState: string | null;
  toState: string;
  reason: string | null;
  actor: string;
  atMs: number;
}

export interface RecordServiceTransitionInput {
  sessionId: number;
  serviceId: string;
  kind: ServiceTransitionKind;
  fromState?: string | null;
  toState: string;
  reason?: string | null;
  actor: string;
  atMs?: number;
}

export interface ListServiceTransitionsOptions {
  serviceId?: string;
  /** Keyset pagination: only rows with id < beforeId (pass the smallest id of the previous page). */
  beforeId?: number;
  limit?: number;
}

interface RawRow {
  id: number;
  session_id: number;
  service_id: string;
  kind: ServiceTransitionKind;
  from_state: string | null;
  to_state: string;
  reason: string | null;
  actor: string;
  at_ms: number;
}

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 500;

function mapRow(r: RawRow): ServiceTransitionRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    serviceId: r.service_id,
    kind: r.kind,
    fromState: r.from_state,
    toState: r.to_state,
    reason: r.reason,
    actor: r.actor,
    atMs: r.at_ms,
  };
}

export class CompanyServiceTransitionsStore {
  constructor(private readonly db: DB) {}

  /** Appends one transition; returns the new row id. */
  record(input: RecordServiceTransitionInput): number {
    const r = this.db
      .prepare(
        `INSERT INTO company_service_transitions
           (session_id, service_id, kind, from_state, to_state, reason, actor, at_ms)
         VALUES (@session_id, @service_id, @kind, @from_state, @to_state, @reason, @actor, @at_ms)`,
      )
      .run({
        session_id: input.sessionId,
        service_id: input.serviceId,
        kind: input.kind,
        from_state: input.fromState ?? null,
        to_state: input.toState,
        reason: input.reason ?? null,
        actor: input.actor,
        at_ms: input.atMs ?? Date.now(),
      });
    return Number(r.lastInsertRowid);
  }

  /** Newest-first page (id DESC) with optional service filter + keyset cursor. */
  listPage(sessionId: number, opts: ListServiceTransitionsOptions = {}): ServiceTransitionRow[] {
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT));
    const where: string[] = ['session_id = @session_id'];
    const params: Record<string, unknown> = { session_id: sessionId, limit };
    if (opts.serviceId !== undefined) {
      where.push('service_id = @service_id');
      params.service_id = opts.serviceId;
    }
    if (opts.beforeId !== undefined) {
      where.push('id < @before_id');
      params.before_id = opts.beforeId;
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM company_service_transitions
         WHERE ${where.join(' AND ')}
         ORDER BY id DESC
         LIMIT @limit`,
      )
      .all(params) as RawRow[];
    return rows.map(mapRow);
  }

  /** Drops the whole trail of a session (session teardown). Returns rows deleted. */
  purgeSession(sessionId: number): number {
    const r = this.db
      .prepare('DELETE FROM company_service_transitions WHERE session_id = ?')
      .run(sessionId);
    return r.changes ?? 0;
  }
}
