/**
 * Shared type vocabulary for the per-session databases feature.
 *
 * Consumed by backend (store, routes, agent tools) AND frontend
 * (DatabasesTab). Keeping these names + shapes in a single module is
 * the DRY contract that prevents provider fields from drifting
 * between the layers.
 */

export type DatabaseProvider = 'postgres' | 'mysql' | 'supabase' | 'neon';
export type DatabaseWireProtocol = 'postgres' | 'mysql';

/**
 * Map from the provider's canonical field name (stable — what the
 * registry defines) to the actual env key chosen for this DB instance.
 *
 * Example (primary Postgres): { DATABASE_URL: 'DATABASE_URL' }
 * Example (secondary Postgres): { DATABASE_URL: 'DATABASE_URL_ANALYTICS' }
 */
export type EnvKeyMap = Record<string, string>;

export interface CompanySessionDatabaseRow {
  id: number;
  session_id: number;
  label: string;
  provider: DatabaseProvider;
  is_primary: 0 | 1;
  env_keys_json: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

/** Hydrated view returned by the store (JSON columns parsed). */
export interface CompanySessionDatabase {
  id: number;
  session_id: number;
  label: string;
  provider: DatabaseProvider;
  is_primary: boolean;
  env_keys: EnvKeyMap;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
}
