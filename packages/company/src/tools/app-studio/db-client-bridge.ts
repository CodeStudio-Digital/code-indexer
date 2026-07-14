/**
 * Bridge App Studio's managed local DB into the native project DB Client.
 *
 * The db_* agent tools intentionally only see `db_connections`. App Studio's
 * local D1 database is created by Wrangler/Miniflare, so we register that
 * SQLite file as a managed project connection instead of teaching db_* about
 * App Studio internals.
 */
import type { AppStudioSession } from '@mcp/store/app-studio-store.js';
import type {
  CreateDbConnectionInput,
  DbConnection,
  DbConnectionPatch,
} from '@mcp/store/db-client-store-types.js';

export interface AppStudioDbClientStore {
  listConnections(projectId: number): DbConnection[];
  createConnection(input: CreateDbConnectionInput): DbConnection;
  updateConnection(projectId: number, id: number, patch: DbConnectionPatch): void;
}

let dbClientStore: AppStudioDbClientStore | null = null;

export function setAppStudioDbClientStore(store: AppStudioDbClientStore | null): void {
  dbClientStore = store;
}

export function getAppStudioDbClientStore(): AppStudioDbClientStore | null {
  return dbClientStore;
}

export interface EnsureAppStudioDbConnectionResult {
  connection: DbConnection;
  created: boolean;
}

export const APP_STUDIO_DB_CONNECTION_GROUP = 'App Studio';
export const APP_STUDIO_DB_CONNECTION_COLOR = '#14b8a6';

function managedOptions(session: AppStudioSession): Record<string, unknown> {
  return {
    managedBy: 'app-studio',
    appSessionId: session.id,
    appSlug: session.app_slug,
    bindingName: 'DB',
    local: true,
  };
}

function parseOptions(conn: Pick<DbConnection, 'options_json'>): Record<string, unknown> {
  try {
    return JSON.parse(conn.options_json || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isManagedAppStudioConnection(conn: DbConnection, session: AppStudioSession): boolean {
  const options = parseOptions(conn);
  return (
    options.managedBy === 'app-studio' &&
    (options.appSessionId === session.id || options.appSlug === session.app_slug)
  );
}

function connectionInput(session: AppStudioSession, dbFile: string): CreateDbConnectionInput {
  return {
    project_id: session.project_id,
    label: `App Studio: ${session.name}`,
    engine: 'sqlite',
    database_name: `${session.app_slug}-db`,
    file_path: dbFile,
    options: managedOptions(session),
    color: APP_STUDIO_DB_CONNECTION_COLOR,
    group_name: APP_STUDIO_DB_CONNECTION_GROUP,
    // App Studio schema/data writes must go through versioned app_* tools.
    // The native DB client remains available to the coordinator and delegated workers.
    is_read_only: true,
  };
}

export function ensureAppStudioDbConnection(
  store: AppStudioDbClientStore,
  session: AppStudioSession,
  dbFile: string,
): EnsureAppStudioDbConnectionResult {
  const existing = store
    .listConnections(session.project_id)
    .find((conn) => isManagedAppStudioConnection(conn, session));
  const input = connectionInput(session, dbFile);
  if (!existing) {
    return { connection: store.createConnection(input), created: true };
  }

  store.updateConnection(session.project_id, existing.id, {
    label: input.label,
    engine: input.engine,
    database_name: input.database_name,
    file_path: input.file_path,
    options: input.options,
    color: input.color,
    group_name: input.group_name,
    is_read_only: input.is_read_only,
  });
  const refreshed = store
    .listConnections(session.project_id)
    .find((conn) => conn.id === existing.id);
  return { connection: refreshed ?? existing, created: false };
}
