/**
 * CompanyLocalProjectStore — persistence for host-process projects
 * (migration 042). Sibling of `CompanySandboxServicesStore`; each row
 * is keyed by `session_id` (1:1 in the MVP — at most one local project
 * per session).
 *
 * The store knows nothing about the running OS process — the in-memory
 * `LocalProcessManager` owns that. This table only captures what must
 * survive a server restart: the spawn recipe (program/argv/env/cwd)
 * plus the last observed status. On boot the reconciler flips any
 * `provisioning`/`running` rows to `destroyed` with error
 * `'server-restart'` (we can't re-parent a PID across restarts on
 * Windows and we don't try on POSIX either — Retry is the UX).
 */

import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export type LocalProjectStatus =
  | 'provisioning'
  | 'running'
  | 'destroying'
  | 'destroyed'
  | 'error';

export type LocalProjectSynthSource = 'ai' | 'fallback' | 'fallback-after-ai-failure';

export type LocalProjectManifestKind = 'node' | 'python' | 'go' | 'rust' | 'ruby';

export interface PersistedLocalProjectRow {
  session_id: number;
  cwd: string;
  manifest_kind: LocalProjectManifestKind;
  program: string;
  args_json: string;
  env_json: string;
  host_port: number;
  rationale: string;
  synth_source: LocalProjectSynthSource;
  status: LocalProjectStatus;
  error: string | null;
  pid: number | null;
  last_access_at_ms: number;
  created_at: string;
  updated_at: string;
}

export interface UpsertLocalProjectInput {
  session_id: number;
  cwd: string;
  manifest_kind: LocalProjectManifestKind;
  program: string;
  args: readonly string[];
  env: Record<string, string>;
  host_port: number;
  rationale: string;
  synth_source: LocalProjectSynthSource;
  status: LocalProjectStatus;
  error?: string | null;
  pid?: number | null;
  last_access_at_ms?: number;
}

export class CompanyLocalProjectStore {
  constructor(private readonly db: DB) {}

  upsert(input: UpsertLocalProjectInput): PersistedLocalProjectRow {
    const now = input.last_access_at_ms ?? Date.now();
    this.db
      .prepare(
        `
        INSERT INTO company_local_projects (
          session_id, cwd, manifest_kind, program, args_json, env_json,
          host_port, rationale, synth_source, status, error, pid,
          last_access_at_ms, updated_at
        ) VALUES (
          @session_id, @cwd, @manifest_kind, @program, @args_json, @env_json,
          @host_port, @rationale, @synth_source, @status, @error, @pid,
          @last_access_at_ms, datetime('now')
        )
        ON CONFLICT(session_id) DO UPDATE SET
          cwd = excluded.cwd,
          manifest_kind = excluded.manifest_kind,
          program = excluded.program,
          args_json = excluded.args_json,
          env_json = excluded.env_json,
          host_port = excluded.host_port,
          rationale = excluded.rationale,
          synth_source = excluded.synth_source,
          status = excluded.status,
          error = excluded.error,
          pid = excluded.pid,
          last_access_at_ms = excluded.last_access_at_ms,
          updated_at = datetime('now')
        `,
      )
      .run({
        session_id: input.session_id,
        cwd: input.cwd,
        manifest_kind: input.manifest_kind,
        program: input.program,
        args_json: JSON.stringify([...input.args]),
        env_json: JSON.stringify(input.env ?? {}),
        host_port: input.host_port,
        rationale: input.rationale,
        synth_source: input.synth_source,
        status: input.status,
        error: input.error ?? null,
        pid: input.pid ?? null,
        last_access_at_ms: now,
      });
    return this.get(input.session_id)!;
  }

  patch(
    sessionId: number,
    patch: Partial<{
      status: LocalProjectStatus;
      error: string | null;
      pid: number | null;
      last_access_at_ms: number;
    }>,
  ): void {
    const fields: string[] = [];
    const values: Record<string, unknown> = { session_id: sessionId };
    if (patch.status !== undefined) {
      fields.push('status = @status');
      values.status = patch.status;
    }
    if (patch.error !== undefined) {
      fields.push('error = @error');
      values.error = patch.error;
    }
    if (patch.pid !== undefined) {
      fields.push('pid = @pid');
      values.pid = patch.pid;
    }
    if (patch.last_access_at_ms !== undefined) {
      fields.push('last_access_at_ms = @last_access_at_ms');
      values.last_access_at_ms = patch.last_access_at_ms;
    }
    if (fields.length === 0) return;
    fields.push("updated_at = datetime('now')");
    this.db
      .prepare(
        `UPDATE company_local_projects SET ${fields.join(', ')} WHERE session_id = @session_id`,
      )
      .run(values);
  }

  get(sessionId: number): PersistedLocalProjectRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM company_local_projects WHERE session_id = ?')
        .get(sessionId) as PersistedLocalProjectRow | undefined) ?? null
    );
  }

  /** All non-destroyed rows. Bootstrap reconciliation walks this list. */
  listActive(): PersistedLocalProjectRow[] {
    return this.db
      .prepare(
        `SELECT * FROM company_local_projects
         WHERE status != 'destroyed'
         ORDER BY last_access_at_ms DESC`,
      )
      .all() as PersistedLocalProjectRow[];
  }

  listBySession(sessionId: number): PersistedLocalProjectRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM company_local_projects
           WHERE session_id = ? AND status != 'destroyed'`,
        )
        .get(sessionId) as PersistedLocalProjectRow | undefined) ?? null
    );
  }

  delete(sessionId: number): void {
    this.db.prepare('DELETE FROM company_local_projects WHERE session_id = ?').run(sessionId);
  }

  /**
   * Called once at boot to mark as destroyed any row left in a live
   * status by the previous server instance. Returns the PIDs so the
   * caller can SIGTERM them — the DB knows nothing about OS signals.
   */
  reconcileOnBoot(): { cleaned: number; orphanedPids: number[] } {
    const rows = this.db
      .prepare(
        `SELECT pid FROM company_local_projects
           WHERE status IN ('provisioning','running','destroying')
             AND pid IS NOT NULL`,
      )
      .all() as Array<{ pid: number }>;
    const orphanedPids = rows.map((r) => r.pid);

    const result = this.db
      .prepare(
        `UPDATE company_local_projects
           SET status = 'destroyed',
               error = COALESCE(error, 'server-restart'),
               updated_at = datetime('now')
         WHERE status IN ('provisioning','running','destroying')`,
      )
      .run();
    return { cleaned: Number(result.changes ?? 0), orphanedPids };
  }
}
