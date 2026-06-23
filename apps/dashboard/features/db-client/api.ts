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
import { apiBaseUrl, apiCall } from '../../lib/api-client.js';
import { encryptSecret, decryptSecret } from '@mcp/secret-box';
import type {
  DbConnection,
  DbConnectSpec,
  DbIntrospectResult,
  DbQueryResult,
  DbSavedQuery,
  DbTableInfo,
  DbQueryHistoryRow,
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
/**
 * Build a live connect spec from a saved connection row, decrypting the secret
 * just-in-time. The plaintext never leaves this process.
 */
export async function resolveSpec(conn: DbConnection): Promise<DbConnectSpec> {
  const password = conn.enc_password ? await decryptSecret(conn.enc_password) : undefined;
  return {
    connectionId: String(conn.id),
    engine: conn.engine,
    host: conn.host ?? undefined,
    port: conn.port ?? undefined,
    username: conn.username ?? undefined,
    password,
    database: conn.database_name ?? undefined,
    filePath: conn.file_path ?? undefined,
    ssl: conn.ssl_mode ? { mode: conn.ssl_mode } : undefined,
    readOnly: conn.is_read_only === 1,
  };
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
  apiCall<string[]>('dbClient.listDatabases', { connectionId });

export const introspect = (connectionId: string, database?: string, schema?: string) =>
  apiCall<DbIntrospectResult>('dbClient.introspect', { connectionId, database, schema });

export const describeTable = (connectionId: string, schema: string, table: string) =>
  apiCall<DbTableInfo>('dbClient.describeTable', { connectionId, schema, table });

export const runQuery = (
  connectionId: string,
  sql: string,
  opts?: { params?: unknown[]; maxRows?: number; queryId?: string },
) => apiCall<DbQueryResult>('dbClient.query', { connectionId, sql, ...opts });

export const cancelQuery = (connectionId: string, queryId: string) =>
  apiCall<void>('dbClient.cancel', { connectionId, queryId });
