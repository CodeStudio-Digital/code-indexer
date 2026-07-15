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
import type {
  DbConnection,
  DbConnectSpec,
  DbIntrospectResult,
  DbQueryResult,
  DbSavedQuery,
  DbTableInfo,
  DbQueryHistoryRow,
  DbRowChangeKind,
  DbDdlOp,
  DbDdlSpec,
  DbEditResult,
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

export const reorderConnections = (p: number, orderedIds: number[]) =>
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
  // Postgres and SQL Server bind a pool to one database; browsing another db
  // needs a separate pool. Key it `id@db` so the manager keeps it distinct. URL mode
  // bakes the db into the DSN with no field to override, so it's field-mode only
  // — otherwise we'd mint an `id@db` pool that still connects to the URL's db.
  const useDb = options.urlMode !== true && dbOverride && dbOverride !== conn.database_name ? dbOverride : undefined;
  const base = {
    connectionId: useDb ? `${conn.id}@${useDb}` : String(conn.id),
    engine: conn.engine,
    ssl,
    options: connectOptions,
    readOnly: conn.is_read_only === 1,
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
export function parseConnKey(connKey: string): { id: number; database?: string } {
  const at = connKey.indexOf('@');
  if (at < 0) return { id: Number(connKey) };
  return { id: Number(connKey.slice(0, at)), database: connKey.slice(at + 1) };
}

// ─── Auto-reconnect safety net ───────────────────────────────────────────
// A live pool can vanish (main-process restart, manual disconnect). The hook
// registers a resolver that rebuilds a connect spec from the saved row so a
// failed op can transparently reconnect + retry once instead of dead-ending.
let specResolver: ((connectionId: string) => Promise<DbConnectSpec | null>) | null = null;
export function setSpecResolver(fn: ((connectionId: string) => Promise<DbConnectSpec | null>) | null): void {
  specResolver = fn;
}

function isNotConnected(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  const msg = e instanceof Error ? e.message : String(e);
  return code === 'db_not_connected' || /not connected/i.test(msg);
}

async function withReconnect<T>(connectionId: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (e) {
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

export const disconnect = (connectionId: string) =>
  apiCall<void>('dbClient.disconnect', { connectionId });

export const listDatabases = (connectionId: string) =>
  withReconnect(connectionId, () => apiCall<string[]>('dbClient.listDatabases', { connectionId }));

export const introspect = (connectionId: string, database?: string, schema?: string) =>
  withReconnect(connectionId, () => apiCall<DbIntrospectResult>('dbClient.introspect', { connectionId, database, schema }));

export const describeTable = (connectionId: string, schema: string, table: string) =>
  withReconnect(connectionId, () => apiCall<DbTableInfo>('dbClient.describeTable', { connectionId, schema, table }));

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

export const ddl = (input: { connectionId: string; op: DbDdlOp; spec: DbDdlSpec; dryRun?: boolean }) =>
  withReconnect(input.connectionId, () => apiCall<DbEditResult>('dbClient.ddl', input));

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
): AsyncIterable<DbRowBatch> {
  return apiStream<DbRowBatch>('dbClient.exportStream', { connectionId, schema, table, batchRows });
}

/** Stream a `.sql` dump (CREATE + INSERTs) for a whole schema or selected tables. */
export function dumpStream(
  connectionId: string,
  opts: { schema?: string; tables?: string[]; includeData?: boolean; batchRows?: number },
): AsyncIterable<DbDumpFrame> {
  return apiStream<DbDumpFrame>('dbClient.dumpStream', { connectionId, ...opts });
}

/** Run a restore/import script (statement list) on one pinned connection. */
export const runScript = (connectionId: string, statements: string[]) =>
  withReconnect(connectionId, () => apiCall<DbQueryResult>('dbClient.runScript', { connectionId, statements }));
