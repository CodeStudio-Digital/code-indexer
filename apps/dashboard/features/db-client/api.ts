/**
 * Thin wrappers over the db-client backend.
 *
 *  - METADATA (saved connections / history / saved queries) → Hono CRUD via
 *    `fetch` against `apiBaseUrl()` (same pattern as the api-client feature).
 *  - LIVE ops (connect / introspect / query / cancel) → the `dbClient` api-bus
 *    namespace via `apiCall` (in-process IPC in Electron).
 *
 * Secrets: the renderer encrypts before persisting and decrypts just-in-time
 * before building a connect spec, using `@mcp/secret-box` (OS keychain). The
 * plaintext password lives only in renderer memory and crosses only the
 * in-process IPC channel.
 */
import { apiBaseUrl, apiCall, apiStream } from '../../lib/api-client.js';
import { encryptSecret, decryptSecret } from '@mcp/secret-box';
import { connectionKey, parseConnKey } from './connection-key.js';
export { connectionKey, parseConnKey } from './connection-key.js';
import {
  findHostByKey,
  listHosts as listSshHosts,
  listIdentities as listSshIdentities,
  resolveSpecFromHost as resolveSshSpec,
  sshHostKey,
} from '../ssh/api.js';
import type { SshHost } from '../ssh/types.js';
import type {
  DbConnection,
  DbConnectSpec,
  DbIntrospectResult,
  DbCatalogObject,
  DbCatalogSnapshot,
  DbSchemaSnapshot,
  DbQueryResult,
  DbQueryBatchResult,
  DbSavedQuery,
  DbTableInfo,
  DbIncomingForeignKey,
  DbQueryHistoryRow,
  DbRowChangeKind,
  DbDdlOp,
  DbDdlSpec,
  DbEditResult,
  DbRowChangeInput,
  DbBatchEditResult,
  DbMigrationInput,
  DbMigrationResult,
  DbObjectKind,
  DbGenerateKind,
  DbRowBatch,
  DbDumpFrame,
  DbEngine,
  DbDriverStatus,
  DbDriverInstallFrame,
  DbTableSort,
  DbWhereCondition,
  DbCommand,
} from './types.js';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* keep status */
    }
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('application/json') ? await res.json() : await res.text()) as T;
}

const root = (projectId: number) => `/api/projects/${projectId}/db-client`;
const j = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

// ─── Connections CRUD ────────────────────────────────────────────────────
export const listConnections = (p: number) =>
  req<{ connections: DbConnection[] }>(`${root(p)}/connections`).then((r) => r.connections);

export const createConnection = (p: number, body: Record<string, unknown>) =>
  req<DbConnection>(`${root(p)}/connections`, j(body));

export const patchConnection = (p: number, cid: number, patch: Record<string, unknown>) =>
  req<DbConnection>(`${root(p)}/connections/${cid}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const deleteConnection = (p: number, cid: number) =>
  req<{ ok: true }>(`${root(p)}/connections/${cid}`, { method: 'DELETE' });

const reorderConnections = (p: number, orderedIds: number[]) =>
  req<{ connections: DbConnection[] }>(`${root(p)}/connections/0/reorder`, j({ orderedIds })).then(
    (r) => r.connections,
  );

export const touchConnection = (p: number, cid: number) =>
  req<{ ok: true }>(`${root(p)}/connections/${cid}/touch`, { method: 'POST' });

// ─── History ─────────────────────────────────────────────────────────────
export const listHistory = (p: number, cid: number, limit = 100) =>
  req<{ history: DbQueryHistoryRow[] }>(`${root(p)}/connections/${cid}/history?limit=${limit}`).then(
    (r) => r.history,
  );

export const addHistory = (p: number, cid: number, body: Record<string, unknown>) =>
  req<DbQueryHistoryRow>(`${root(p)}/connections/${cid}/history`, j(body));

export const clearHistory = (p: number, cid: number) =>
  req<{ ok: true }>(`${root(p)}/connections/${cid}/history`, { method: 'DELETE' });

export const deleteHistoryRow = (p: number, hid: number) =>
  req<{ ok: true }>(`${root(p)}/history/${hid}`, { method: 'DELETE' });

// ─── Saved queries ───────────────────────────────────────────────────────
export const listSavedQueries = (p: number) =>
  req<{ savedQueries: DbSavedQuery[] }>(`${root(p)}/saved-queries`).then((r) => r.savedQueries);

export const createSavedQuery = (p: number, body: Record<string, unknown>) =>
  req<DbSavedQuery>(`${root(p)}/saved-queries`, j(body));

export const deleteSavedQuery = (p: number, sqid: number) =>
  req<{ ok: true }>(`${root(p)}/saved-queries/${sqid}`, { method: 'DELETE' });

// ─── Secret helpers (device-bound, OS keychain) ──────────────────────────
export const encryptSecretValue = (plain: string) => encryptSecret(plain);

// ─── Live ops (api-bus dbClient) ─────────────────────────────────────────
/** Parse the options_json blob (never throws). */
export function parseConnOptions(conn: DbConnection): Record<string, unknown> {
  try {
    return JSON.parse(conn.options_json || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * URL-mode connections carry the whole DSN (with the database baked in) as one
 * encrypted blob — there's no separate `database` to override, so dedicated
 * per-database browsing (Postgres/SQL Server) doesn't apply to them.
 */
export function isUrlMode(conn: DbConnection): boolean {
  return parseConnOptions(conn).urlMode === true;
}

/** The subset of options passed to the driver pool (timeout / app name). */
function pickConnectOptions(options: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (typeof options.connectTimeoutMs === 'number') out.connectTimeoutMs = options.connectTimeoutMs;
  if (typeof options.applicationName === 'string' && options.applicationName) out.applicationName = options.applicationName;
  return Object.keys(out).length ? out : undefined;
}

async function resolveSsl(conn: DbConnection): Promise<DbConnectSpec['ssl']> {
  if (!conn.ssl_mode || conn.ssl_mode === 'disable') return undefined;
  return {
    mode: conn.ssl_mode,
    ca: conn.enc_ssl_ca ? await decryptSecret(conn.enc_ssl_ca) : undefined,
    cert: conn.enc_ssl_cert ? await decryptSecret(conn.enc_ssl_cert) : undefined,
    key: conn.enc_ssl_key ? await decryptSecret(conn.enc_ssl_key) : undefined,
  };
}

interface StoredDbTunnel {
  hostKey?: string;
  remoteHost?: string;
  remotePort?: number;
}

function parseTunnelOptions(conn: DbConnection): StoredDbTunnel {
  if (!conn.ssh_tunnel_json) return {};
  try {
    return JSON.parse(conn.ssh_tunnel_json) as StoredDbTunnel;
  } catch {
    return {};
  }
}

/** Resolve a saved SSH host (including identity + jump chain) for a DB forward. */
export async function resolveSshTunnel(
  projectId: number,
  hostKey: string,
  remoteHost: string,
  remotePort: number,
): Promise<NonNullable<DbConnectSpec['sshTunnel']>> {
  const [hosts, identities] = await Promise.all([listSshHosts(projectId), listSshIdentities(projectId)]);
  const host = findHostByKey(hosts, hostKey) ?? hosts.find((item) => String(item.id) === hostKey);
  if (!host) throw new Error(`SSH host not found: ${hostKey}`);
  return { spec: await resolveSshSpec(host, hosts, identities), remoteHost, remotePort };
}

export async function listDbTunnelHosts(projectId: number): Promise<Array<{ key: string; host: SshHost }>> {
  return (await listSshHosts(projectId)).map((host) => ({ key: sshHostKey(host), host }));
}

/**
 * Build a live connect spec from a saved connection row, decrypting secrets
 * just-in-time. In URL mode the encrypted blob IS the full connection string
 * (which carries the password, so it stays device-bound encrypted at rest).
 * The plaintext never leaves this process.
 */
export async function resolveSpec(conn: DbConnection, dbOverride?: string): Promise<DbConnectSpec> {
  const options = parseConnOptions(conn);
  const secret = conn.enc_password ? await decryptSecret(conn.enc_password) : '';
  const ssl = await resolveSsl(conn);
  const connectOptions = pickConnectOptions(options);
  const tunnelOptions = parseTunnelOptions(conn);
  const sshTunnel = conn.ssh_tunnel_host_id != null && conn.host && conn.port
    ? await resolveSshTunnel(
        conn.project_id,
        tunnelOptions.hostKey ?? String(conn.ssh_tunnel_host_id),
        tunnelOptions.remoteHost ?? conn.host,
        tunnelOptions.remotePort ?? conn.port,
      )
    : undefined;
  // Postgres and SQL Server bind a pool to one database; browsing another db
  // needs a separate pool. Key it `id@db` so the manager keeps it distinct. URL mode
  // bakes the db into the DSN with no field to override, so it's field-mode only
  // — otherwise we'd mint an `id@db` pool that still connects to the URL's db.
  const useDb = options.urlMode !== true && dbOverride && dbOverride !== conn.database_name ? dbOverride : undefined;
  const base = {
    connectionId: connectionKey(conn.project_id, conn.id, useDb),
    engine: conn.engine,
    ssl,
    options: connectOptions,
    readOnly: conn.is_read_only === 1,
    sshTunnel,
  };
  if (options.urlMode === true) {
    return { ...base, connectionString: secret || undefined };
  }
  return {
    ...base,
    host: conn.host ?? undefined,
    port: conn.port ?? undefined,
    username: conn.username ?? undefined,
    password: secret || undefined,
    database: dbOverride ?? conn.database_name ?? undefined,
    filePath: conn.file_path ?? undefined,
  };
}

/** Split a routing key (`5` or `5@otherdb`) into its numeric id + optional db. */

// ─── Auto-reconnect safety net ───────────────────────────────────────────
// A live pool can vanish (main-process restart, manual disconnect). The hook
// registers a resolver that rebuilds a connect spec from the saved row so a
// failed op can transparently reconnect + retry once instead of dead-ending.
const specResolvers = new Map<number, (connectionId: string) => Promise<DbConnectSpec | null>>();
export function setSpecResolver(fn: ((connectionId: string) => Promise<DbConnectSpec | null>) | null, projectId = 0): void {
  if (fn) specResolvers.set(projectId, fn);
  else specResolvers.delete(projectId);
}

function isNotConnected(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  const msg = e instanceof Error ? e.message : String(e);
  return code === 'db_not_connected';
}

async function withReconnect<T>(connectionId: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (e) {
    const specResolver = specResolvers.get(parseConnKey(connectionId).projectId ?? 0);
    if (!isNotConnected(e) || !specResolver) throw e;
    const spec = await specResolver(connectionId).catch(() => null);
    if (!spec) throw e;
    await connect(spec);
    return op(); // retry once after reconnecting
  }
}

export const testConnection = (spec: DbConnectSpec) =>
  apiCall<{ ok: true; serverVersion?: string } | { ok: false; reason: string }>('dbClient.testConnection', {
    spec,
  });

export const connect = (spec: DbConnectSpec) =>
  apiCall<{ sessionToken: string; serverVersion?: string }>('dbClient.connect', { spec });

export const disconnect = (connectionId: string) => {
  invalidateTableInfo(connectionId);
  return apiCall<void>('dbClient.disconnect', { connectionId });
};

export const listDatabases = (connectionId: string) =>
  withReconnect(connectionId, () => apiCall<string[]>('dbClient.listDatabases', { connectionId }));

export const introspect = (connectionId: string, database?: string, schema?: string) =>
  withReconnect(connectionId, () => apiCall<DbIntrospectResult>('dbClient.introspect', { connectionId, database, schema }));

export const catalog = (connectionId: string, force = false, scope: { schema?: string; query?: string; cursor?: string; limit?: number } = {}, signal?: AbortSignal) =>
  withReconnect(connectionId, () => { signal?.throwIfAborted(); return apiCall<DbCatalogSnapshot>('dbClient.catalog', { connectionId, force, ...scope }, { signal }); });

export const searchCatalog = (connectionId: string, query: string, limit = 100, signal?: AbortSignal) =>
  withReconnect(connectionId, () => { signal?.throwIfAborted(); return apiCall<DbCatalogObject[]>('dbClient.searchCatalog', { connectionId, query, limit }, { signal }); });

export const schemaSnapshot = (connectionId: string, schema: string) =>
  withReconnect(connectionId, () => apiCall<DbSchemaSnapshot>('dbClient.schemaSnapshot', { connectionId, schema }));

// ─── describeTable cache ─────────────────────────────────────────────────
// Every surface needs a table's columns: the data grid (primary key + types),
// the SQL editor's autocomplete, the row editor, the related-rows dialog, the
// structure tab, and the tree's Indexes/Foreign keys folders. Uncached, opening
// one table fired the same introspection query four or five times, and each one
// is a multi-join over information_schema. The entry holds the PROMISE, so
// callers that race share a single round trip instead of stampeding.
const DESCRIBE_TTL_MS = 60_000;
const describeCache = new Map<string, { at: number; value: Promise<DbTableInfo> }>();

const describeKey = (connectionId: string, schema: string, table: string) => `${connectionId}\0${schema}\0${table}`;

/**
 * Drop cached column metadata. Pass a connection id (or `id@db` key) to clear
 * just that connection — DDL anywhere on it can invalidate any of its tables.
 */
export function invalidateTableInfo(connectionId?: string): void {
  if (!connectionId) {
    describeCache.clear();
    return;
  }
  const prefix = `${connectionId}\0`;
  for (const key of describeCache.keys()) {
    if (key.startsWith(prefix)) describeCache.delete(key);
  }
}

export const describeTable = (connectionId: string, schema: string, table: string): Promise<DbTableInfo> => {
  const key = describeKey(connectionId, schema, table);
  const hit = describeCache.get(key);
  if (hit && Date.now() - hit.at < DESCRIBE_TTL_MS) return hit.value;
  const value = withReconnect(connectionId, () =>
    apiCall<DbTableInfo>('dbClient.describeTable', { connectionId, schema, table }));
  // A failed lookup must not be remembered — the next caller should retry.
  value.catch(() => describeCache.delete(key));
  describeCache.set(key, { at: Date.now(), value });
  return value;
};

export const incomingForeignKeys = (connectionId: string, schema: string, table: string) =>
  withReconnect(connectionId, () => apiCall<DbIncomingForeignKey[]>('dbClient.incomingForeignKeys', { connectionId, schema, table }));

export const tableRows = (
  connectionId: string,
  schema: string,
  table: string,
  limit: number,
  offset: number,
  orderBy?: DbTableSort,
  where?: DbWhereCondition[],
) => withReconnect(connectionId, () => apiCall<DbQueryResult>('dbClient.tableRows', { connectionId, schema, table, limit, offset, orderBy, where }));

export const listObjects = (
  connectionId: string,
  kind: DbObjectKind,
  schema?: string,
  table?: string,
) => withReconnect(connectionId, () => apiCall<string[]>('dbClient.listObjects', { connectionId, kind, schema, table }));

export const generateSql = (connectionId: string, schema: string | undefined, table: string, kind: DbGenerateKind) =>
  withReconnect(connectionId, () => apiCall<{ sql: string }>('dbClient.generateSql', { connectionId, schema, table, kind }));

export const runQuery = (
  connectionId: string,
  sql: string,
  opts?: { params?: unknown[]; maxRows?: number; timeoutMs?: number; queryId?: string; schema?: string },
) => withReconnect(connectionId, () => apiCall<DbQueryResult>('dbClient.query', { connectionId, sql, ...opts }));

export const runQueryBatch = (
  connectionId: string,
  statements: Array<{ sql: string; params?: unknown[] }>,
  opts?: { maxRows?: number; timeoutMs?: number; queryId?: string; schema?: string },
) => withReconnect(connectionId, () => apiCall<DbQueryBatchResult>('dbClient.queryBatch', { connectionId, statements, ...opts }));

export const runMigration = async (connectionId: string, changes: DbMigrationInput[], dryRun = false) => {
  const result = await withReconnect(connectionId, () => apiCall<DbMigrationResult>('dbClient.migration', { connectionId, changes, dryRun }));
  if (!dryRun) invalidateTableInfo(connectionId);
  return result;
};

export const cancelQuery = (connectionId: string, queryId: string) =>
  apiCall<void>('dbClient.cancel', { connectionId, queryId });

export const explain = (connectionId: string, sql: string) =>
  withReconnect(connectionId, () => apiCall<DbQueryResult>('dbClient.explain', { connectionId, sql }));

export const editRow = (input: {
  connectionId: string;
  op: DbRowChangeKind;
  schema?: string;
  table: string;
  pk?: Record<string, unknown>;
  values?: Record<string, unknown>;
  dryRun?: boolean;
}) => withReconnect(input.connectionId, () => apiCall<DbEditResult>('dbClient.editRow', input));

export const editRows = (input: { connectionId: string; changes: DbRowChangeInput[]; dryRun?: boolean }) =>
  withReconnect(input.connectionId, () => apiCall<DbBatchEditResult>('dbClient.editRows', input));

export const ddl = async (input: { connectionId: string; op: DbDdlOp; spec: DbDdlSpec; dryRun?: boolean }) => {
  const result = await withReconnect(input.connectionId, () => apiCall<DbEditResult>('dbClient.ddl', input));
  // A dry run only renders SQL; a real one may have changed any table's shape.
  if (!input.dryRun) invalidateTableInfo(input.connectionId);
  return result;
};

/** Run a non-relational command (Mongo document op / Redis command). */
export const runCommand = (connectionId: string, command: DbCommand, maxRows?: number) =>
  withReconnect(connectionId, () => apiCall<DbQueryResult>('dbClient.runCommand', { connectionId, command, maxRows }));

/** Install status of the lazily-downloaded drivers (Oracle/Mongo/Redis). */
export const driverStatus = () => apiCall<DbDriverStatus[]>('dbClient.driverStatus', {});

/** Download + install an on-demand driver, streaming progress frames. */
export function installDriverStream(engine: DbEngine): AsyncIterable<DbDriverInstallFrame> {
  return apiStream<DbDriverInstallFrame>('dbClient.installDriverStream', { engine });
}

/** Stream a whole table out in row batches (server-paged, unbounded). */
export function exportStream(
  connectionId: string,
  schema: string | undefined,
  table: string,
  batchRows?: number,
  jobId?: string,
): AsyncIterable<DbRowBatch> {
  return apiStream<DbRowBatch>('dbClient.exportStream', { connectionId, schema, table, batchRows, jobId });
}

/** Stream a `.sql` dump (CREATE + INSERTs) for a whole schema or selected tables. */
export function dumpStream(
  connectionId: string,
  opts: { schema?: string; tables?: string[]; includeData?: boolean; batchRows?: number; jobId?: string },
): AsyncIterable<DbDumpFrame> {
  return apiStream<DbDumpFrame>('dbClient.dumpStream', { connectionId, ...opts });
}

/** Run a restore/import script (statement list) on one pinned connection. */
export const runScript = async (connectionId: string, statements: string[], options: { jobId?: string; signal?: AbortSignal } = {}) => {
  const jobId = options.jobId ?? crypto.randomUUID();
  const result = await withReconnect(connectionId, () => apiCall<DbQueryResult>('dbClient.runScript', { connectionId, statements, jobId }, { signal: options.signal }));
  // A restore script is arbitrary DDL — assume every table on it moved.
  invalidateTableInfo(connectionId);
  return result;
};

export const jobStatus = (connectionId: string, jobId: string) =>
  apiCall<import('@mcp/api-bus').DbJobStatus>('dbClient.jobStatus', { connectionId, jobId });
export const cancelJob = (connectionId: string, jobId: string) =>
  apiCall<import('@mcp/api-bus').DbJobStatus>('dbClient.cancelJob', { connectionId, jobId });
