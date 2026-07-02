/**
 * Agent-side pool acquisition over the process-shared `DbConnectionManager`
 * (same registry the Databases-tab handlers use, distinct `agent:` keyspace,
 * idle-evictable). Rotation-aware: each acquire compares the row's
 * `updated_at` with the one seen last time — a mismatch means the user edited
 * credentials/settings, so the stale pool is closed BEFORE re-acquiring.
 *
 * NOTE: `@mcp/db-drivers` manager/factory pull the native sqlite driver at
 * module load (ABI-bound), so they are imported LAZILY here — this module (and
 * tools.ts above it) stays importable under plain-node vitest.
 */
import type { DatabaseDriver } from '@mcp/db-drivers/types.js';
// type-only: erased at compile time, so the ABI-bound manager is NOT loaded here.
import type { ConnMeta } from '@mcp/db-drivers/manager.js';
import type { DbConnection } from '@mcp/store/db-client-store-types.js';
import { resolveConnConfig, type ResolvedDbSpec } from './resolve-spec.js';
import { getDbSecretDecryptor } from './store-binding.js';

type Manager = typeof import('@mcp/db-drivers/manager.js');

/** Distinct keyspace from the UI pools (`conn:<id>`). */
export function agentPoolKey(conn: Pick<DbConnection, 'project_id' | 'id'>): string {
  return `agent:${conn.project_id}:${conn.id}`;
}

/** `updated_at` observed at the last acquire, per pool key. */
const lastSeenUpdatedAt = new Map<string, string>();
/** Resolved spec cached per key so error scrubbing keeps its secret list. */
const specCache = new Map<string, ResolvedDbSpec>();

export interface AcquiredDb {
  driver: DatabaseDriver;
  key: string;
  /** Enforcement source of truth — same `getMeta` the UI handler reads. */
  meta: ConnMeta;
  /** For `scrubDbError` — secrets of the config this pool was built from. */
  spec: ResolvedDbSpec | null;
}

export async function acquireAgentDriver(conn: DbConnection): Promise<AcquiredDb> {
  const { sharedDbConnectionManager } = (await import(
    '@mcp/db-drivers/manager.js'
  )) as Manager;
  const mgr = sharedDbConnectionManager();
  const key = agentPoolKey(conn);
  const prev = lastSeenUpdatedAt.get(key);
  if (prev !== undefined && prev !== conn.updated_at) {
    // Credential/settings rotation — drop the stale pool (and its cached
    // secrets) so the next acquire reconnects with the fresh row.
    await mgr.closeKey(key);
    specCache.delete(key);
  }
  let driver = mgr.get(key);
  let spec = specCache.get(key) ?? null;
  if (!driver) {
    spec = await resolveConnConfig(conn, getDbSecretDecryptor());
    driver = await mgr.acquire(key, spec.config, { invalidatePrefix: key });
    specCache.set(key, spec);
  }
  lastSeenUpdatedAt.set(key, conn.updated_at);
  mgr.setMeta(key, {
    engine: conn.engine,
    readOnly: conn.is_read_only === 1,
    kind: driver.kind ?? 'relational',
  });
  return { driver, key, meta: mgr.getMeta(key) ?? {}, spec };
}
