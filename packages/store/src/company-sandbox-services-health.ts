/**
 * CompanySandboxServicesHealth — health-column queries for
 * `company_sandbox_services` (migration 188, company B1).
 *
 * Extracted from `CompanySandboxServicesStore` to respect the file LOC
 * cap; the store composes this class and re-exposes both methods, so
 * callers keep a single entry point. Health is the supervisor-probe
 * verdict ('unknown' seed; TEXT without CHECK — the probe vocabulary
 * will evolve), orthogonal to the container lifecycle in `status`.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export interface UpdateServiceHealthInput {
  health: string;
  healthDetail?: string | null;
  lastHealthAtMs?: number;
}

export class CompanySandboxServicesHealth {
  constructor(private readonly db: DB) {}

  /**
   * Sets the probe verdict for one service. Returns false when the
   * `(session, service)` row does not exist (nothing updated).
   */
  updateHealth(
    sessionId: number,
    serviceId: string,
    input: UpdateServiceHealthInput,
  ): boolean {
    const r = this.db
      .prepare(
        `UPDATE company_sandbox_services
            SET health = @health,
                health_detail = @health_detail,
                last_health_at_ms = @last_health_at_ms,
                updated_at = datetime('now')
          WHERE session_id = @session_id AND service_id = @service_id`,
      )
      .run({
        session_id: sessionId,
        service_id: serviceId,
        health: input.health,
        health_detail: input.healthDetail ?? null,
        last_health_at_ms: input.lastHealthAtMs ?? Date.now(),
      });
    return (r.changes ?? 0) > 0;
  }

  /**
   * Atomically increments `restart_count` (single UPDATE — safe under
   * WAL) and returns the new value, or null when the row does not exist.
   */
  bumpRestartCount(sessionId: number, serviceId: string): number | null {
    const r = this.db
      .prepare(
        `UPDATE company_sandbox_services
            SET restart_count = restart_count + 1,
                updated_at = datetime('now')
          WHERE session_id = @session_id AND service_id = @service_id`,
      )
      .run({ session_id: sessionId, service_id: serviceId });
    if ((r.changes ?? 0) === 0) return null;
    const row = this.db
      .prepare(
        `SELECT restart_count FROM company_sandbox_services
          WHERE session_id = ? AND service_id = ?`,
      )
      .get(sessionId, serviceId) as { restart_count: number } | undefined;
    return row?.restart_count ?? null;
  }
}
