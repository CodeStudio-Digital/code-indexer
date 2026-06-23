/**
 * Row + input types for the embedded database client store (migration 174).
 *
 * `enc_*` fields hold OS-keychain ciphertext (base64) — or a `v1:` vault
 * envelope — produced by the renderer's `secrets` shim. The store never sees
 * plaintext secrets.
 */

export type DbEngine = 'postgres' | 'mysql' | 'mariadb' | 'sqlite' | 'mssql' | 'mongodb' | 'redis' | 'oracle';
export type DbSslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';

export interface DbConnection {
  id: number;
  project_id: number;
  label: string;
  engine: DbEngine;
  host: string | null;
  port: number | null;
  username: string | null;
  database_name: string | null;
  file_path: string | null;
  enc_password: string | null;
  ssl_mode: DbSslMode | null;
  enc_ssl_ca: string | null;
  enc_ssl_cert: string | null;
  enc_ssl_key: string | null;
  ssh_tunnel_host_id: number | null;
  ssh_tunnel_json: string | null;
  /** JSON object of engine-specific extra options. */
  options_json: string;
  color: string | null;
  group_name: string | null;
  sort_order: number;
  is_read_only: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateDbConnectionInput {
  project_id: number;
  label: string;
  engine: DbEngine;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  database_name?: string | null;
  file_path?: string | null;
  enc_password?: string | null;
  ssl_mode?: DbSslMode | null;
  enc_ssl_ca?: string | null;
  enc_ssl_cert?: string | null;
  enc_ssl_key?: string | null;
  ssh_tunnel_host_id?: number | null;
  ssh_tunnel_json?: string | null;
  options?: Record<string, unknown>;
  color?: string | null;
  group_name?: string | null;
  is_read_only?: boolean;
}
export type DbConnectionPatch = Partial<Omit<CreateDbConnectionInput, 'project_id'>>;

export type DbQueryStatus = 'ok' | 'error' | 'cancelled';

export interface DbQueryHistoryRow {
  id: number;
  project_id: number;
  connection_id: number | null;
  sql: string;
  database_name: string | null;
  duration_ms: number | null;
  row_count: number | null;
  status: DbQueryStatus;
  error_message: string | null;
  executed_at: string;
}
export interface CreateDbQueryHistoryInput {
  project_id: number;
  connection_id: number | null;
  sql: string;
  database_name?: string | null;
  duration_ms?: number | null;
  row_count?: number | null;
  status?: DbQueryStatus;
  error_message?: string | null;
}

export interface DbSavedQuery {
  id: number;
  project_id: number;
  connection_id: number | null;
  name: string;
  sql: string;
  description: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}
export interface CreateDbSavedQueryInput {
  project_id: number;
  connection_id?: number | null;
  name: string;
  sql: string;
  description?: string | null;
}
export type DbSavedQueryPatch = Partial<Omit<CreateDbSavedQueryInput, 'project_id'>>;
