/**
 * DbClientStore — CRUD for the embedded database client tables (migration 174):
 * saved connections + query history + saved queries. Project-scoped. Dual-mode
 * constructor (path | shared DB handle), same as ApiClientStore / SshStore.
 *
 * The store is intentionally Electron-free and crypto-free: `enc_*` columns are
 * persisted verbatim as opaque tagged blobs (the renderer encrypts via the OS
 * keychain before writing). This keeps the store unit-testable under
 * better-sqlite3 without the Electron ABI, and means a leaked DB file holds only
 * device-bound ciphertext.
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import type {
  DbConnection,
  CreateDbConnectionInput,
  DbConnectionPatch,
  DbQueryHistoryRow,
  CreateDbQueryHistoryInput,
  DbSavedQuery,
  CreateDbSavedQueryInput,
  DbSavedQueryPatch,
} from './db-client-store-types.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;
type Row = Record<string, unknown>;

export class DbClientStore {
  private db: DB;

  constructor(dbOrPath: DB | string) {
    this.db = typeof dbOrPath === 'string' ? new Database(dbOrPath) : dbOrPath;
  }

  // ─── Connections ─────────────────────────────────────────────────────
  listConnections(projectId: number): DbConnection[] {
    return this.db
      .prepare('SELECT * FROM db_connections WHERE project_id = ? ORDER BY sort_order, label')
      .all(projectId) as DbConnection[];
  }

  getConnection(id: number): DbConnection | null {
    return (
      (this.db.prepare('SELECT * FROM db_connections WHERE id = ?').get(id) as DbConnection | undefined) ?? null
    );
  }

  createConnection(input: CreateDbConnectionInput): DbConnection {
    const nextSort = this.db
      .prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM db_connections WHERE project_id = ?')
      .get(input.project_id) as { n: number };
    const info = this.db
      .prepare(
        `INSERT INTO db_connections
           (project_id, label, engine, host, port, username, database_name, file_path,
            enc_password, ssl_mode, enc_ssl_ca, enc_ssl_cert, enc_ssl_key,
            ssh_tunnel_host_id, ssh_tunnel_json, options_json, color, group_name,
            sort_order, is_read_only)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.project_id,
        input.label,
        input.engine,
        input.host ?? null,
        input.port ?? null,
        input.username ?? null,
        input.database_name ?? null,
        input.file_path ?? null,
        input.enc_password ?? null,
        input.ssl_mode ?? null,
        input.enc_ssl_ca ?? null,
        input.enc_ssl_cert ?? null,
        input.enc_ssl_key ?? null,
        input.ssh_tunnel_host_id ?? null,
        input.ssh_tunnel_json ?? null,
        JSON.stringify(input.options ?? {}),
        input.color ?? null,
        input.group_name ?? null,
        nextSort.n,
        input.is_read_only ? 1 : 0,
      );
    return this.getConnection(Number(info.lastInsertRowid))!;
  }

  updateConnection(id: number, patch: DbConnectionPatch): void {
    const cols: Record<string, unknown> = { ...patch };
    if ('options' in cols) {
      cols.options_json = JSON.stringify((cols.options as Record<string, unknown> | undefined) ?? {});
      delete cols.options;
    }
    if ('is_read_only' in cols) cols.is_read_only = cols.is_read_only ? 1 : 0;
    this.applyPatch('db_connections', id, cols);
  }

  deleteConnection(id: number): void {
    this.db.prepare('DELETE FROM db_query_history WHERE connection_id = ?').run(id);
    this.db.prepare('UPDATE db_saved_queries SET connection_id = NULL WHERE connection_id = ?').run(id);
    this.db.prepare('DELETE FROM db_connections WHERE id = ?').run(id);
  }

  touchConnectionUsed(id: number): void {
    this.db.prepare(`UPDATE db_connections SET last_used_at = datetime('now') WHERE id = ?`).run(id);
  }

  /** Reorder connections within a project: assign sort_order by array position. */
  reorderConnections(projectId: number, orderedIds: number[]): void {
    const upd = this.db.prepare('UPDATE db_connections SET sort_order = ? WHERE id = ? AND project_id = ?');
    const tx = this.db.transaction((ids: number[]) => {
      ids.forEach((id, i) => upd.run(i, id, projectId));
    });
    tx(orderedIds);
  }

  // ─── Query history ───────────────────────────────────────────────────
  listHistory(connectionId: number, limit = 100): DbQueryHistoryRow[] {
    return this.db
      .prepare('SELECT * FROM db_query_history WHERE connection_id = ? ORDER BY executed_at DESC, id DESC LIMIT ?')
      .all(connectionId, limit) as DbQueryHistoryRow[];
  }

  getHistoryRow(id: number): DbQueryHistoryRow | null {
    return (
      (this.db.prepare('SELECT * FROM db_query_history WHERE id = ?').get(id) as DbQueryHistoryRow | undefined) ??
      null
    );
  }

  addHistory(input: CreateDbQueryHistoryInput): DbQueryHistoryRow {
    const info = this.db
      .prepare(
        `INSERT INTO db_query_history
           (project_id, connection_id, sql, database_name, duration_ms, row_count, status, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.project_id,
        input.connection_id ?? null,
        input.sql,
        input.database_name ?? null,
        input.duration_ms ?? null,
        input.row_count ?? null,
        input.status ?? 'ok',
        input.error_message ?? null,
      );
    return this.getHistoryRow(Number(info.lastInsertRowid))!;
  }

  deleteHistoryRow(id: number): void {
    this.db.prepare('DELETE FROM db_query_history WHERE id = ?').run(id);
  }

  clearHistory(connectionId: number): void {
    this.db.prepare('DELETE FROM db_query_history WHERE connection_id = ?').run(connectionId);
  }

  // ─── Saved queries ───────────────────────────────────────────────────
  listSavedQueries(projectId: number): DbSavedQuery[] {
    return this.db
      .prepare('SELECT * FROM db_saved_queries WHERE project_id = ? ORDER BY sort_order, name')
      .all(projectId) as DbSavedQuery[];
  }

  getSavedQuery(id: number): DbSavedQuery | null {
    return (
      (this.db.prepare('SELECT * FROM db_saved_queries WHERE id = ?').get(id) as DbSavedQuery | undefined) ?? null
    );
  }

  createSavedQuery(input: CreateDbSavedQueryInput): DbSavedQuery {
    const info = this.db
      .prepare(
        `INSERT INTO db_saved_queries (project_id, connection_id, name, sql, description)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.project_id,
        input.connection_id ?? null,
        input.name,
        input.sql,
        input.description ?? null,
      );
    return this.getSavedQuery(Number(info.lastInsertRowid))!;
  }

  updateSavedQuery(id: number, patch: DbSavedQueryPatch): void {
    this.applyPatch('db_saved_queries', id, { ...patch });
  }

  deleteSavedQuery(id: number): void {
    this.db.prepare('DELETE FROM db_saved_queries WHERE id = ?').run(id);
  }

  /**
   * Build + run an UPDATE from a partial column map, always bumping updated_at.
   *
   * SECURITY: column NAMES are interpolated into SQL (only values are bound), and
   * the `cols` map originates from an HTTP PATCH body. Each key is validated
   * against a per-table allow-list of writable columns BEFORE building the SET
   * clause — an unknown key throws rather than reaching the query. This blocks
   * column-name SQL injection + cross-project re-parenting. Mirrors SshStore.
   */
  private applyPatch(table: string, id: number, cols: Record<string, unknown>): void {
    const keys = Object.keys(cols).filter((k) => cols[k] !== undefined);
    if (keys.length === 0) return;
    const allow = WRITABLE_COLUMNS[table];
    for (const k of keys) {
      if (!allow || !allow.has(k)) throw new Error(`db-client-store: column not writable in ${table}: ${k}`);
    }
    const set = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => normalizeValue(cols[k] as Row[string]));
    this.db.prepare(`UPDATE ${table} SET ${set}, updated_at = datetime('now') WHERE id = ?`).run(...values, id);
  }
}

/** Per-table allow-list of caller-writable columns (never `id`/`project_id`/`created_at`). */
const WRITABLE_COLUMNS: Record<string, ReadonlySet<string>> = {
  db_connections: new Set([
    'label', 'engine', 'host', 'port', 'username', 'database_name', 'file_path',
    'enc_password', 'ssl_mode', 'enc_ssl_ca', 'enc_ssl_cert', 'enc_ssl_key',
    'ssh_tunnel_host_id', 'ssh_tunnel_json', 'options_json', 'color', 'group_name',
    'sort_order', 'is_read_only', 'last_used_at',
  ]),
  db_saved_queries: new Set(['connection_id', 'name', 'sql', 'description', 'sort_order']),
};

/** SQLite can't bind booleans/objects — coerce to its supported primitives. */
function normalizeValue(v: unknown): unknown {
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v ?? null;
}
