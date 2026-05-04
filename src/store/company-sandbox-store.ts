/**
 * CompanySandboxStore — persistent state for SandboxManager.
 *
 * Keeps a 1:1 row per company_session that has ever had a builder
 * sandbox. The in-memory `SandboxManager.sandboxes` Map becomes a cache
 * of the rows with `status != 'destroyed'`; every state transition
 * writes through to this store so a process restart can rebuild the
 * map exactly (+ reconcile each entry with the OCI runtime via
 * `driver.inspectContainer`).
 *
 * Shape of the `status` column matches `SandboxStatus` in
 * src/core/sandbox/types.ts so consumers can cast strings directly.
 */

import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export type PersistedSandboxStatus =
  | 'provisioning'
  | 'running'
  | 'paused'
  | 'destroying'
  | 'destroyed'
  | 'error';

export interface PersistedSandboxRow {
  session_id: number;
  container_id: string;
  runtime: 'docker' | 'podman' | 'e2b';
  stack: string;
  workdir: string;
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
  last_access_at_ms: number;
  paused_at_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertSandboxInput {
  session_id: number;
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
  last_access_at_ms?: number;
  paused_at_ms?: number | null;
}

export class CompanySandboxStore {
  constructor(private readonly db: DB) {}

  /**
   * Insert or fully replace the row for `session_id`. Used at provision
   * start and on every transition to `running`/`paused` — we never
   * retain a stale partial state.
   */
  upsert(input: UpsertSandboxInput): PersistedSandboxRow {
    const now = input.last_access_at_ms ?? Date.now();
    this.db
      .prepare(
        `
        INSERT INTO company_sandboxes (
          session_id, container_id, runtime, stack, workdir, host_port,
          host_workdir_mount, limits_json, status, error, mount_kind,
          image_source, built_image_tag, dockerfile_path, dockerfile_exposed_port,
          last_access_at_ms, paused_at_ms,
          updated_at
        ) VALUES (
          @session_id, @container_id, @runtime, @stack, @workdir, @host_port,
          @host_workdir_mount, @limits_json, @status, @error, @mount_kind,
          @image_source, @built_image_tag, @dockerfile_path, @dockerfile_exposed_port,
          @last_access_at_ms, @paused_at_ms,
          datetime('now')
        )
        ON CONFLICT(session_id) DO UPDATE SET
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
          last_access_at_ms = excluded.last_access_at_ms,
          paused_at_ms = excluded.paused_at_ms,
          updated_at = datetime('now')
        `,
      )
      .run({
        session_id: input.session_id,
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
        last_access_at_ms: now,
        paused_at_ms: input.paused_at_ms ?? null,
      });
    return this.get(input.session_id)!;
  }

  /**
   * Cheap partial update — used on `.touch()` and status transitions
   * that don't rewrite the whole row. Caller provides whichever fields
   * matter.
   */
  patch(sessionId: number, patch: Partial<Omit<UpsertSandboxInput, 'session_id'>>): void {
    const fields: string[] = [];
    const values: Record<string, unknown> = { session_id: sessionId };
    if (patch.status !== undefined) {
      fields.push('status = @status');
      values.status = patch.status;
    }
    if (patch.container_id !== undefined) {
      fields.push('container_id = @container_id');
      values.container_id = patch.container_id;
    }
    if (patch.error !== undefined) {
      fields.push('error = @error');
      values.error = patch.error;
    }
    if (patch.last_access_at_ms !== undefined) {
      fields.push('last_access_at_ms = @last_access_at_ms');
      values.last_access_at_ms = patch.last_access_at_ms;
    }
    if (patch.paused_at_ms !== undefined) {
      fields.push('paused_at_ms = @paused_at_ms');
      values.paused_at_ms = patch.paused_at_ms;
    }
    if (patch.limits !== undefined) {
      fields.push('limits_json = @limits_json');
      values.limits_json = JSON.stringify(patch.limits);
    }
    if (patch.host_workdir_mount !== undefined) {
      fields.push('host_workdir_mount = @host_workdir_mount');
      values.host_workdir_mount = patch.host_workdir_mount;
    }
    if (patch.mount_kind !== undefined) {
      fields.push('mount_kind = @mount_kind');
      values.mount_kind = patch.mount_kind;
    }
    if (patch.image_source !== undefined) {
      fields.push('image_source = @image_source');
      values.image_source = patch.image_source;
    }
    if (patch.built_image_tag !== undefined) {
      fields.push('built_image_tag = @built_image_tag');
      values.built_image_tag = patch.built_image_tag;
    }
    if (patch.dockerfile_path !== undefined) {
      fields.push('dockerfile_path = @dockerfile_path');
      values.dockerfile_path = patch.dockerfile_path;
    }
    if (patch.dockerfile_exposed_port !== undefined) {
      fields.push('dockerfile_exposed_port = @dockerfile_exposed_port');
      values.dockerfile_exposed_port = patch.dockerfile_exposed_port;
    }
    if (fields.length === 0) return;
    fields.push("updated_at = datetime('now')");
    this.db
      .prepare(`UPDATE company_sandboxes SET ${fields.join(', ')} WHERE session_id = @session_id`)
      .run(values);
  }

  get(sessionId: number): PersistedSandboxRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM company_sandboxes WHERE session_id = ?')
        .get(sessionId) as PersistedSandboxRow | undefined) ?? null
    );
  }

  /**
   * Every non-destroyed sandbox. Used by SandboxManager on boot to
   * rebuild its in-memory map and reconcile each with the OCI runtime.
   * Ordered by `last_access_at_ms` desc so the reconcile loop touches
   * likely-active sandboxes first.
   */
  listActive(): PersistedSandboxRow[] {
    return this.db
      .prepare(
        `SELECT * FROM company_sandboxes
         WHERE status != 'destroyed'
         ORDER BY last_access_at_ms DESC`,
      )
      .all() as PersistedSandboxRow[];
  }

  /**
   * Paused sandboxes older than `maxPausedMs`. Fed into the hard-TTL
   * reaper, which promotes them to destroyed.
   */
  listPausedOlderThan(maxPausedMs: number): PersistedSandboxRow[] {
    const cutoff = Date.now() - maxPausedMs;
    return this.db
      .prepare(
        `SELECT * FROM company_sandboxes
         WHERE status = 'paused' AND paused_at_ms IS NOT NULL AND paused_at_ms < ?`,
      )
      .all(cutoff) as PersistedSandboxRow[];
  }

  /**
   * Hard-delete the row. Called after the container has been destroyed
   * and the archive (if any) has been dealt with. We prefer a real
   * delete here (not a status='destroyed' flag) so indices stay small
   * — the audit trail is the `updated_at` history if needed; session
   * deletion cascades anyway.
   */
  delete(sessionId: number): void {
    this.db.prepare('DELETE FROM company_sandboxes WHERE session_id = ?').run(sessionId);
  }
}
