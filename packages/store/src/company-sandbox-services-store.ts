/**
 * CompanySandboxServicesStore — per-service persistence for the
 * multi-microservice sandbox model introduced in migration 035.
 *
 * Relationship to `CompanySandboxStore` (migration 034):
 *   - `company_sandboxes` remains the 1:1 "primary service" shortcut
 *     used by reconciliation, the TTL reaper, and legacy single-service
 *     call sites. It mirrors whichever service has `is_primary = 1`.
 *   - `company_sandbox_services` is the authoritative list when a
 *     session hosts multiple microservices (frontend + worker + php,
 *     etc.). The manager's `provisionAdditionalService` path reads/
 *     writes here.
 *
 * Rows are composite-keyed `(session_id, service_id)`. `service_id` is
 * a human-readable token (e.g. 'frontend', 'api') that doubles as the
 * in-network hostname so agents can write `fetch('http://api/')` in
 * their code.
 */

import type DatabaseConstructor from 'better-sqlite3';
import type { PersistedSandboxStatus } from './company-sandbox-store.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export interface PersistedSandboxServiceRow {
  session_id: number;
  service_id: string;
  name: string;
  container_id: string;
  runtime: 'docker' | 'podman' | 'e2b';
  stack: string;
  workdir: string;
  /** Absolute host path bind-mounted onto `workdir`. Null for legacy rows. */
  host_workdir_mount: string | null;
  host_port: number;
  limits_json: string;
  status: PersistedSandboxStatus;
  error: string | null;
  mount_kind: 'owned' | 'external';
  image_source: 'default' | 'project_dockerfile';
  built_image_tag: string | null;
  dockerfile_path: string | null;
  dockerfile_exposed_port: number | null;
  is_primary: 0 | 1;
  last_access_at_ms: number;
  paused_at_ms: number | null;
  created_at: string;
  updated_at: string;
  /** 1 = service references an externally-managed container we never start/stop. */
  is_attached: 0 | 1;
  /** User-supplied container id or name (only meaningful when is_attached=1). */
  external_container_ref: string | null;
  /** DNS hostname peer containers use to reach this service. */
  attached_hostname: string | null;
}

export interface UpsertSandboxServiceInput {
  session_id: number;
  service_id: string;
  name?: string;
  container_id: string;
  runtime: 'docker' | 'podman' | 'e2b';
  stack: string;
  workdir: string;
  host_workdir_mount?: string | null;
  host_port: number;
  limits: Record<string, unknown>;
  status: PersistedSandboxStatus;
  error?: string | null;
  mount_kind?: 'owned' | 'external';
  image_source?: 'default' | 'project_dockerfile';
  built_image_tag?: string | null;
  dockerfile_path?: string | null;
  dockerfile_exposed_port?: number | null;
  is_primary?: boolean;
  last_access_at_ms?: number;
  paused_at_ms?: number | null;
  is_attached?: boolean;
  external_container_ref?: string | null;
  attached_hostname?: string | null;
}

export class CompanySandboxServicesStore {
  constructor(private readonly db: DB) {}

  upsert(input: UpsertSandboxServiceInput): PersistedSandboxServiceRow {
    const now = input.last_access_at_ms ?? Date.now();
    this.db
      .prepare(
        `
        INSERT INTO company_sandbox_services (
          session_id, service_id, name, container_id, runtime, stack,
          workdir, host_workdir_mount, host_port, limits_json, status,
          error, mount_kind, image_source, built_image_tag, dockerfile_path,
          dockerfile_exposed_port, is_primary, last_access_at_ms, paused_at_ms,
          is_attached, external_container_ref, attached_hostname, updated_at
        ) VALUES (
          @session_id, @service_id, @name, @container_id, @runtime, @stack,
          @workdir, @host_workdir_mount, @host_port, @limits_json, @status,
          @error, @mount_kind, @image_source, @built_image_tag, @dockerfile_path,
          @dockerfile_exposed_port, @is_primary, @last_access_at_ms, @paused_at_ms,
          @is_attached, @external_container_ref, @attached_hostname, datetime('now')
        )
        ON CONFLICT(session_id, service_id) DO UPDATE SET
          name = excluded.name,
          container_id = excluded.container_id,
          runtime = excluded.runtime,
          stack = excluded.stack,
          workdir = excluded.workdir,
          host_workdir_mount = excluded.host_workdir_mount,
          host_port = excluded.host_port,
          limits_json = excluded.limits_json,
          status = excluded.status,
          error = excluded.error,
          mount_kind = excluded.mount_kind,
          image_source = excluded.image_source,
          built_image_tag = excluded.built_image_tag,
          dockerfile_path = excluded.dockerfile_path,
          dockerfile_exposed_port = excluded.dockerfile_exposed_port,
          is_primary = excluded.is_primary,
          last_access_at_ms = excluded.last_access_at_ms,
          paused_at_ms = excluded.paused_at_ms,
          is_attached = excluded.is_attached,
          external_container_ref = excluded.external_container_ref,
          attached_hostname = excluded.attached_hostname,
          updated_at = datetime('now')
        `,
      )
      .run({
        session_id: input.session_id,
        service_id: input.service_id,
        name: input.name ?? '',
        container_id: input.container_id,
        runtime: input.runtime,
        stack: input.stack,
        workdir: input.workdir,
        host_workdir_mount: input.host_workdir_mount ?? null,
        host_port: input.host_port,
        limits_json: JSON.stringify(input.limits ?? {}),
        status: input.status,
        error: input.error ?? null,
        mount_kind: input.mount_kind ?? 'owned',
        image_source: input.image_source ?? 'default',
        built_image_tag: input.built_image_tag ?? null,
        dockerfile_path: input.dockerfile_path ?? null,
        dockerfile_exposed_port: input.dockerfile_exposed_port ?? null,
        is_primary: input.is_primary ? 1 : 0,
        last_access_at_ms: now,
        paused_at_ms: input.paused_at_ms ?? null,
        is_attached: input.is_attached ? 1 : 0,
        external_container_ref: input.external_container_ref ?? null,
        attached_hostname: input.attached_hostname ?? null,
      });
    return this.get(input.session_id, input.service_id)!;
  }

  /**
   * Defensive cleanup: a previous provisioning attempt may have left a
   * row pointing at this `container_id` in a non-destroyed state when
   * the spawn crashed between the INSERT and the success UPDATE. The
   * partial unique index `idx_company_sandbox_services_container`
   * (migration 035) only enforces uniqueness on non-destroyed rows, so
   * marking the stragglers `destroyed` reopens the slot for the fresh
   * upsert.
   *
   * The `excludeSessionId`/`excludeServiceId` pair is the row the
   * caller is *about* to upsert — we never demote it because the
   * upsert itself owns its lifecycle.
   */
  releaseStaleContainerId(
    containerId: string,
    excludeSessionId: number,
    excludeServiceId: string,
  ): number {
    const r = this.db
      .prepare(
        `UPDATE company_sandbox_services
            SET status = 'destroyed',
                updated_at = datetime('now')
          WHERE container_id = ?
            AND status != 'destroyed'
            AND NOT (session_id = ? AND service_id = ?)`,
      )
      .run(containerId, excludeSessionId, excludeServiceId);
    return r.changes ?? 0;
  }

  /**
   * Same idea as `releaseStaleContainerId` but for the
   * `idx_company_sandbox_services_port` partial unique index. When the
   * port allocator hands out a host port that an old, non-destroyed
   * row still holds (typically because a previous container died
   * without a clean teardown), the upsert below would fail with
   * `UNIQUE constraint failed: company_sandbox_services.host_port`.
   *
   * Marking the straggler `destroyed` is safe — it's not the row the
   * caller is about to upsert, and "destroyed" is the convention for
   * "this row is no longer alive" everywhere else in the codebase.
   * The exclude pair protects the caller's own (session, service)
   * row, so re-provisioning the same service on the same port stays
   * a vanilla upsert.
   */
  releaseStaleHostPort(
    hostPort: number,
    excludeSessionId: number,
    excludeServiceId: string,
  ): number {
    const r = this.db
      .prepare(
        `UPDATE company_sandbox_services
            SET status = 'destroyed',
                updated_at = datetime('now')
          WHERE host_port = ?
            AND status != 'destroyed'
            AND NOT (session_id = ? AND service_id = ?)`,
      )
      .run(hostPort, excludeSessionId, excludeServiceId);
    return r.changes ?? 0;
  }

  patch(
    sessionId: number,
    serviceId: string,
    patch: Partial<Omit<UpsertSandboxServiceInput, 'session_id' | 'service_id'>>,
  ): void {
    const fields: string[] = [];
    const values: Record<string, unknown> = { session_id: sessionId, service_id: serviceId };
    if (patch.status !== undefined) { fields.push('status = @status'); values.status = patch.status; }
    if (patch.container_id !== undefined) { fields.push('container_id = @container_id'); values.container_id = patch.container_id; }
    if (patch.error !== undefined) { fields.push('error = @error'); values.error = patch.error; }
    if (patch.last_access_at_ms !== undefined) { fields.push('last_access_at_ms = @last_access_at_ms'); values.last_access_at_ms = patch.last_access_at_ms; }
    if (patch.paused_at_ms !== undefined) { fields.push('paused_at_ms = @paused_at_ms'); values.paused_at_ms = patch.paused_at_ms; }
    if (patch.limits !== undefined) { fields.push('limits_json = @limits_json'); values.limits_json = JSON.stringify(patch.limits); }
    if (patch.name !== undefined) { fields.push('name = @name'); values.name = patch.name; }
    if (patch.is_primary !== undefined) { fields.push('is_primary = @is_primary'); values.is_primary = patch.is_primary ? 1 : 0; }
    if (patch.mount_kind !== undefined) { fields.push('mount_kind = @mount_kind'); values.mount_kind = patch.mount_kind; }
    if (patch.image_source !== undefined) { fields.push('image_source = @image_source'); values.image_source = patch.image_source; }
    if (patch.built_image_tag !== undefined) { fields.push('built_image_tag = @built_image_tag'); values.built_image_tag = patch.built_image_tag; }
    if (patch.dockerfile_path !== undefined) { fields.push('dockerfile_path = @dockerfile_path'); values.dockerfile_path = patch.dockerfile_path; }
    if (patch.dockerfile_exposed_port !== undefined) { fields.push('dockerfile_exposed_port = @dockerfile_exposed_port'); values.dockerfile_exposed_port = patch.dockerfile_exposed_port; }
    if (patch.is_attached !== undefined) { fields.push('is_attached = @is_attached'); values.is_attached = patch.is_attached ? 1 : 0; }
    if (patch.external_container_ref !== undefined) { fields.push('external_container_ref = @external_container_ref'); values.external_container_ref = patch.external_container_ref; }
    if (patch.attached_hostname !== undefined) { fields.push('attached_hostname = @attached_hostname'); values.attached_hostname = patch.attached_hostname; }
    if (fields.length === 0) return;
    fields.push("updated_at = datetime('now')");
    this.db
      .prepare(
        `UPDATE company_sandbox_services SET ${fields.join(', ')}
         WHERE session_id = @session_id AND service_id = @service_id`,
      )
      .run(values);
  }

  get(sessionId: number, serviceId: string): PersistedSandboxServiceRow | null {
    return (
      (this.db
        .prepare(
          'SELECT * FROM company_sandbox_services WHERE session_id = ? AND service_id = ?',
        )
        .get(sessionId, serviceId) as PersistedSandboxServiceRow | undefined) ?? null
    );
  }

  listBySession(sessionId: number): PersistedSandboxServiceRow[] {
    return this.db
      .prepare(
        `SELECT * FROM company_sandbox_services
         WHERE session_id = ? AND status != 'destroyed'
         ORDER BY is_primary DESC, created_at ASC`,
      )
      .all(sessionId) as PersistedSandboxServiceRow[];
  }

  /**
   * Like `listBySession` but also returns rows left behind by a
   * transient destroy (retry, abort, session-end, reaper). The HTTP
   * `/services` handler uses this so the UI can surface orphaned
   * services — rows whose container is gone but whose project files
   * are still on disk — and offer a Retry that picks up the stack
   * from the preserved row instead of asking the user again.
   */
  listBySessionAll(sessionId: number): PersistedSandboxServiceRow[] {
    return this.db
      .prepare(
        `SELECT * FROM company_sandbox_services
         WHERE session_id = ?
         ORDER BY is_primary DESC, created_at ASC`,
      )
      .all(sessionId) as PersistedSandboxServiceRow[];
  }

  listActive(): PersistedSandboxServiceRow[] {
    return this.db
      .prepare(
        `SELECT * FROM company_sandbox_services
         WHERE status != 'destroyed'
         ORDER BY last_access_at_ms DESC`,
      )
      .all() as PersistedSandboxServiceRow[];
  }

  delete(sessionId: number, serviceId: string): void {
    this.db
      .prepare(
        'DELETE FROM company_sandbox_services WHERE session_id = ? AND service_id = ?',
      )
      .run(sessionId, serviceId);
  }

  deleteAllForSession(sessionId: number): void {
    this.db
      .prepare('DELETE FROM company_sandbox_services WHERE session_id = ?')
      .run(sessionId);
  }
}
