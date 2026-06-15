/**
 * ApiClientStore — CRUD for the in-app Postman tables (migration 147):
 * collections, environments, requests (verification folded in) and
 * regression-run history. Project-scoped.
 *
 * Dual-mode constructor (path | shared DB handle), same as DesignSystemStore.
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import type {
  ApiCollection, ApiEnvironment, ApiRequest, ApiRegressionRun, ApiRequestHistory,
  ApiRunStatus, ApiRunTrigger, InsertRequestHistoryInput,
  CreateCollectionInput, CreateRequestInput, UpsertEnvironmentInput, RequestPatch,
} from './api-client-types.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

type Row = Record<string, unknown>;
const hydrateCollection = (r: Row): ApiCollection => r as unknown as ApiCollection;
const hydrateEnv = (r: Row): ApiEnvironment => ({ ...(r as object), is_default: !!r.is_default } as ApiEnvironment);
const hydrateRequest = (r: Row): ApiRequest => ({ ...(r as object), verified: !!r.verified } as ApiRequest);
const hydrateRun = (r: Row): ApiRegressionRun => r as unknown as ApiRegressionRun;
const hydrateHistory = (r: Row): ApiRequestHistory => ({ ...(r as object), ok: !!r.ok } as ApiRequestHistory);

export class ApiClientStore {
  private db: DB;

  constructor(dbOrPath: DB | string) {
    this.db = typeof dbOrPath === 'string' ? new Database(dbOrPath) : dbOrPath;
  }

  // ─── Collections ─────────────────────────────────────────────────────
  listCollections(projectId: number): ApiCollection[] {
    return (this.db.prepare('SELECT * FROM api_collections WHERE project_id = ? ORDER BY id DESC')
      .all(projectId) as Row[]).map(hydrateCollection);
  }

  getCollection(id: number): ApiCollection | null {
    const r = this.db.prepare('SELECT * FROM api_collections WHERE id = ?').get(id) as Row | undefined;
    return r ? hydrateCollection(r) : null;
  }

  findCollectionBySpecHash(projectId: number, specHash: string): ApiCollection | null {
    const r = this.db.prepare('SELECT * FROM api_collections WHERE project_id = ? AND spec_hash = ? LIMIT 1')
      .get(projectId, specHash) as Row | undefined;
    return r ? hydrateCollection(r) : null;
  }

  createCollection(input: CreateCollectionInput): ApiCollection {
    const info = this.db.prepare(
      `INSERT INTO api_collections (project_id, name, description, spec_source, spec_hash)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(input.project_id, input.name, input.description ?? '', input.spec_source ?? null, input.spec_hash ?? null);
    return this.getCollection(Number(info.lastInsertRowid))!;
  }

  updateCollection(id: number, patch: { name?: string; description?: string; spec_source?: string | null; spec_hash?: string | null }): void {
    this.applyPatch('api_collections', id, patch);
  }

  deleteCollection(id: number): void {
    // Explicit child delete — FK cascade only fires when PRAGMA foreign_keys is ON.
    this.db.prepare('DELETE FROM api_requests WHERE collection_id = ?').run(id);
    this.db.prepare('DELETE FROM api_regression_runs WHERE collection_id = ?').run(id);
    this.db.prepare('DELETE FROM api_collections WHERE id = ?').run(id);
  }

  // ─── Environments ────────────────────────────────────────────────────
  listEnvironments(projectId: number): ApiEnvironment[] {
    return (this.db.prepare('SELECT * FROM api_environments WHERE project_id = ? ORDER BY is_default DESC, id ASC')
      .all(projectId) as Row[]).map(hydrateEnv);
  }

  getEnvironment(id: number): ApiEnvironment | null {
    const r = this.db.prepare('SELECT * FROM api_environments WHERE id = ?').get(id) as Row | undefined;
    return r ? hydrateEnv(r) : null;
  }

  getDefaultEnvironment(projectId: number): ApiEnvironment | null {
    const r = this.db.prepare('SELECT * FROM api_environments WHERE project_id = ? ORDER BY is_default DESC, id ASC LIMIT 1')
      .get(projectId) as Row | undefined;
    return r ? hydrateEnv(r) : null;
  }

  upsertEnvironment(input: UpsertEnvironmentInput): ApiEnvironment {
    if (input.is_default) {
      this.db.prepare('UPDATE api_environments SET is_default = 0 WHERE project_id = ?').run(input.project_id);
    }
    if (input.id) {
      this.applyPatch('api_environments', input.id, {
        name: input.name, base_url: input.base_url, variables_json: input.variables_json,
        // Only touch is_default when the caller actually sent it — a name-only
        // update must not silently un-default the environment.
        is_default: input.is_default === undefined ? undefined : (input.is_default ? 1 : 0),
      });
      return this.getEnvironment(input.id)!;
    }
    const info = this.db.prepare(
      `INSERT INTO api_environments (project_id, name, base_url, variables_json, is_default)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(input.project_id, input.name, input.base_url ?? '', input.variables_json ?? '{}', input.is_default ? 1 : 0);
    return this.getEnvironment(Number(info.lastInsertRowid))!;
  }

  deleteEnvironment(id: number): void {
    this.db.prepare('DELETE FROM api_environments WHERE id = ?').run(id);
  }

  // ─── Requests ────────────────────────────────────────────────────────
  listRequests(collectionId: number): ApiRequest[] {
    return (this.db.prepare('SELECT * FROM api_requests WHERE collection_id = ? ORDER BY sort_order ASC, id ASC')
      .all(collectionId) as Row[]).map(hydrateRequest);
  }

  getRequest(id: number): ApiRequest | null {
    const r = this.db.prepare('SELECT * FROM api_requests WHERE id = ?').get(id) as Row | undefined;
    return r ? hydrateRequest(r) : null;
  }

  createRequest(input: CreateRequestInput): ApiRequest {
    const info = this.db.prepare(
      `INSERT INTO api_requests
         (collection_id, name, method, path_template, headers_json, query_json, body_json, body_kind, sort_order, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.collection_id, input.name, input.method ?? 'GET', input.path_template ?? '',
      input.headers_json ?? '{}', input.query_json ?? '{}', input.body_json ?? null,
      input.body_kind ?? 'none', input.sort_order ?? 0, input.source ?? 'manual',
    );
    return this.getRequest(Number(info.lastInsertRowid))!;
  }

  updateRequest(id: number, patch: RequestPatch): void {
    this.applyPatch('api_requests', id, patch);
  }

  markVerified(id: number, expectedStatus: number, assertJson?: string | null): void {
    this.db.prepare(
      `UPDATE api_requests SET verified = 1, expected_status = ?, assert_json = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(expectedStatus, assertJson ?? null, id);
  }

  deleteRequest(id: number): void {
    // Explicit child delete — FK cascade only fires when PRAGMA foreign_keys is ON.
    this.db.prepare('DELETE FROM api_request_history WHERE request_id = ?').run(id);
    this.db.prepare('DELETE FROM api_requests WHERE id = ?').run(id);
  }

  // ─── Request history (timeline) ──────────────────────────────────────
  /** Record one send. Caller should prune afterwards to bound growth. */
  insertRequestHistory(input: InsertRequestHistoryInput): void {
    this.db.prepare(
      `INSERT INTO api_request_history (request_id, status, ok, duration_ms, url, error, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.request_id, input.status ?? null, input.ok ? 1 : 0,
      input.duration_ms ?? null, input.url ?? null, input.error ?? null, input.source ?? 'manual',
    );
  }

  listRequestHistory(requestId: number, limit = 50): ApiRequestHistory[] {
    return (this.db.prepare('SELECT * FROM api_request_history WHERE request_id = ? ORDER BY id DESC LIMIT ?')
      .all(requestId, limit) as Row[]).map(hydrateHistory);
  }

  /** Keep only the newest `keep` rows for a request; returns rows pruned. */
  pruneRequestHistory(requestId: number, keep = 50): number {
    const info = this.db.prepare(
      `DELETE FROM api_request_history
        WHERE request_id = ?
          AND id NOT IN (
            SELECT id FROM api_request_history WHERE request_id = ? ORDER BY id DESC LIMIT ?
          )`,
    ).run(requestId, requestId, keep);
    return info.changes;
  }

  // ─── Regression runs ─────────────────────────────────────────────────
  createRun(collectionId: number, envId: number | null, trigger: ApiRunTrigger): number {
    const info = this.db.prepare(
      'INSERT INTO api_regression_runs (collection_id, env_id, trigger) VALUES (?, ?, ?)',
    ).run(collectionId, envId, trigger);
    return Number(info.lastInsertRowid);
  }

  finishRun(id: number, r: { status: ApiRunStatus; total: number; passed: number; failed: number; results_json: string }): void {
    this.db.prepare(
      `UPDATE api_regression_runs SET status = ?, total = ?, passed = ?, failed = ?, results_json = ?, finished_at = datetime('now') WHERE id = ?`,
    ).run(r.status, r.total, r.passed, r.failed, r.results_json, id);
  }

  listRuns(collectionId: number, limit = 20): ApiRegressionRun[] {
    return (this.db.prepare('SELECT * FROM api_regression_runs WHERE collection_id = ? ORDER BY id DESC LIMIT ?')
      .all(collectionId, limit) as Row[]).map(hydrateRun);
  }

  /** Drop a request from the regression battery (renamed/removed in a re-import,
   *  or expectedStatus cleared from the UI). Keeps the row + any manual edits. */
  unverifyRequest(id: number): void {
    this.db.prepare(
      `UPDATE api_requests SET verified = 0, expected_status = NULL, assert_json = NULL, updated_at = datetime('now') WHERE id = ?`,
    ).run(id);
  }

  // ─── internal ────────────────────────────────────────────────────────
  /**
   * Build a dynamic `SET col = ?` update from a partial; no-op when empty.
   * Column names are validated against a per-table allowlist so an
   * untrusted patch (e.g. the PATCH /requests/:rid body) can never inject
   * SQL through an object key.
   */
  private applyPatch(table: string, id: number, patch: Record<string, unknown>): void {
    const allowed = ALLOWED_COLUMNS[table];
    if (!allowed) throw new Error(`applyPatch: unknown table '${table}'`);
    const keys = Object.keys(patch).filter((k) => patch[k] !== undefined && allowed.has(k));
    if (keys.length === 0) return;
    const set = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => patch[k] as never);
    this.db.prepare(`UPDATE ${table} SET ${set}, updated_at = datetime('now') WHERE id = ?`).run(...values, id);
  }
}

/** Columns `applyPatch` may write, per table — guards against key injection. */
const ALLOWED_COLUMNS: Record<string, ReadonlySet<string>> = {
  api_collections: new Set(['name', 'description', 'spec_source', 'spec_hash']),
  api_environments: new Set(['name', 'base_url', 'variables_json', 'is_default']),
  api_requests: new Set([
    'name', 'method', 'path_template', 'headers_json', 'query_json',
    'body_json', 'body_kind', 'sort_order', 'last_status', 'last_run_at',
  ]),
};
