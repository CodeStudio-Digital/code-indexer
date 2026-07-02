/**
 * CompanySessionEnvStore — shared env vars for a company session.
 *
 * Used by:
 *   - REST routes (`GET/PUT/DELETE /api/company/sessions/:id/envs`) so
 *     users manage the list from the Env tab.
 *   - `SandboxManager` at provision/resume time to seed container env.
 *   - The `env_*` agent tools (read / list / set / delete) so agents
 *     can introspect and evolve shared config without leaving the sandbox.
 *
 * The store is a plain CRUD facade; all policy (what's a valid key,
 * whose turn it is to modify, audit trails) lives in the callers.
 */
import type DatabaseConstructor from 'better-sqlite3';
import { normalizeServiceScope, scopeIncludesService } from './env-scope.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export type CompanySessionEnvSource = 'user' | 'imported' | 'auto' | 'agent';

export interface CompanySessionEnvRow {
  session_id: number;
  key: string;
  value: string;
  is_secret: 0 | 1;
  source: CompanySessionEnvSource;
  /**
   * Per-service scope (migration 192): NULL = every service; otherwise
   * a CSV of service ids ('main' addresses the primary container).
   * Parsing/matching semantics live in `env-scope.ts`.
   */
  service_scope: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertOptions {
  /** Provenance tag — see migration 039. Defaults to `'user'`. */
  source?: CompanySessionEnvSource;
  /**
   * Insert-only: when true, skip the write if a row already exists for
   * this (session, key). Used by the `.env` import path so a pre-
   * existing user value is never overwritten by the imported default.
   */
  onlyIfAbsent?: boolean;
  /**
   * Per-service scope. Tri-state on purpose:
   *   - `undefined` (omitted) → an existing row KEEPS its scope; new
   *     rows land unscoped. Legacy callers (managed-env sync, chrome
   *     service) never clobber operator-set scopes this way.
   *   - `null` → explicitly clear the scope (var goes to all services).
   *   - string → CSV of service ids, normalized before storage.
   */
  serviceScope?: string | null;
}

export class CompanySessionEnvStore {
  constructor(private readonly db: DB) {}

  list(sessionId: number): CompanySessionEnvRow[] {
    return this.db
      .prepare(
        'SELECT * FROM company_session_envs WHERE session_id = ? ORDER BY key ASC',
      )
      .all(sessionId) as CompanySessionEnvRow[];
  }

  get(sessionId: number, key: string): CompanySessionEnvRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM company_session_envs WHERE session_id = ? AND key = ?')
        .get(sessionId, key) as CompanySessionEnvRow | undefined) ?? null
    );
  }

  /**
   * Write a key. Upsert — an existing entry's value/is_secret/source
   * fields are overwritten by default, created_at preserved. Pass
   * `onlyIfAbsent: true` to keep existing rows untouched (used by the
   * `.env` import path so imports don't clobber user edits).
   */
  upsert(
    sessionId: number,
    key: string,
    value: string,
    isSecret: boolean,
    opts: UpsertOptions = {},
  ): void {
    const source: CompanySessionEnvSource = opts.source ?? 'user';
    // Tri-state scope: `scopeProvided = 0` keeps the existing row's
    // scope on conflict (see UpsertOptions.serviceScope).
    const scopeProvided = opts.serviceScope !== undefined ? 1 : 0;
    const scope = normalizeServiceScope(opts.serviceScope ?? null);
    if (opts.onlyIfAbsent) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO company_session_envs (session_id, key, value, is_secret, source, service_scope)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(sessionId, key, value, isSecret ? 1 : 0, source, scope);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO company_session_envs (session_id, key, value, is_secret, source, service_scope)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, key) DO UPDATE SET
           value = excluded.value,
           is_secret = excluded.is_secret,
           source = excluded.source,
           service_scope = CASE WHEN ? = 1
             THEN excluded.service_scope
             ELSE company_session_envs.service_scope END,
           updated_at = datetime('now')`,
      )
      .run(sessionId, key, value, isSecret ? 1 : 0, source, scope, scopeProvided);
  }

  delete(sessionId: number, key: string): void {
    this.db
      .prepare('DELETE FROM company_session_envs WHERE session_id = ? AND key = ?')
      .run(sessionId, key);
  }

  /** Flat key→value map, convenient for container env injection. */
  asRecord(sessionId: number): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of this.list(sessionId)) {
      out[row.key] = row.value;
    }
    return out;
  }

  /**
   * Like `asRecord`, but ENFORCES `service_scope` (migration 192): only
   * rows whose scope is NULL (all services) or whose CSV contains
   * `serviceId` land in the record. The primary container's id is
   * `'main'` — same id the services listing and env-sync targets use.
   */
  asRecordForService(sessionId: number, serviceId: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of this.list(sessionId)) {
      if (scopeIncludesService(row.service_scope, serviceId)) {
        out[row.key] = row.value;
      }
    }
    return out;
  }
}
