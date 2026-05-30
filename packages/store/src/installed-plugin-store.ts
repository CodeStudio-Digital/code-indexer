/**
 * InstalledPluginStore — CRUD for the `installed_plugins` table (migration
 * 112), following the same patterns as McpServerStore.
 *
 * JSON columns (source_ref, manifest, contributions) are stored opaque so
 * this store stays decoupled from the manifest SDK — callers in the plugin
 * host apply the typed shapes from @mcp/plugin-sdk.
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

type Json = Record<string, unknown>;

export interface InstalledPlugin {
  namespace: string;
  name: string;
  version: string;
  source: string;
  source_ref: Json | null;
  manifest: Json | null;
  contributions: Json | null;
  enabled: boolean;
  signature: string | null;
  permissions_granted: Record<string, unknown> | null;
  installed_at: string;
  updated_at: string;
}

export interface UpsertInstalledPluginInput {
  namespace: string;
  name: string;
  version: string;
  source: string;
  source_ref?: Json | null;
  manifest?: Json | null;
  contributions?: Json | null;
  enabled?: boolean;
  signature?: string | null;
}

interface InstalledPluginRaw {
  namespace: string;
  name: string;
  version: string;
  source: string;
  source_ref: string | null;
  manifest: string | null;
  contributions: string | null;
  enabled: number;
  signature: string | null;
  permissions_granted: string | null;
  installed_at: string;
  updated_at: string;
}

/** Namespace: lowercase alphanumeric + hyphen/underscore, 1-64 chars. */
const NAMESPACE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function parseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function hydrate(r: InstalledPluginRaw): InstalledPlugin {
  return {
    namespace: r.namespace,
    name: r.name,
    version: r.version,
    source: r.source,
    source_ref: parseJson<Json>(r.source_ref),
    manifest: parseJson<Json>(r.manifest),
    contributions: parseJson<Json>(r.contributions),
    enabled: !!r.enabled,
    signature: r.signature,
    permissions_granted: r.permissions_granted
      ? (JSON.parse(r.permissions_granted) as Record<string, unknown>)
      : null,
    installed_at: r.installed_at,
    updated_at: r.updated_at,
  };
}

/** Serialize a JSON column: undefined → keep `fallback`, null → SQL NULL. */
function jsonCol(v: Json | null | undefined, fallback: Json | null): string | null {
  if (v === undefined) return fallback ? JSON.stringify(fallback) : null;
  return v === null ? null : JSON.stringify(v);
}

export class InstalledPluginStore {
  private db: DB;
  private ownsConnection: boolean;

  constructor(dbPathOrInstance: string | DB) {
    if (typeof dbPathOrInstance === 'string') {
      this.db = new Database(dbPathOrInstance);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.ownsConnection = true;
    } else {
      this.db = dbPathOrInstance;
      this.ownsConnection = false;
    }
  }

  close(): void {
    if (this.ownsConnection) this.db.close();
  }

  list(filter?: { enabled?: boolean }): InstalledPlugin[] {
    const where =
      filter?.enabled !== undefined ? `WHERE enabled = ${filter.enabled ? 1 : 0}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM installed_plugins ${where} ORDER BY name`)
      .all() as InstalledPluginRaw[];
    return rows.map(hydrate);
  }

  get(namespace: string): InstalledPlugin | null {
    const row = this.db
      .prepare('SELECT * FROM installed_plugins WHERE namespace = ?')
      .get(namespace) as InstalledPluginRaw | undefined;
    return row ? hydrate(row) : null;
  }

  upsert(input: UpsertInstalledPluginInput): InstalledPlugin {
    if (!NAMESPACE_RE.test(input.namespace)) {
      throw new Error(
        `Invalid plugin namespace "${input.namespace}": must be 1-64 lowercase alphanumeric + hyphen/underscore`,
      );
    }
    const now = new Date().toISOString();
    const existing = this.get(input.namespace);

    if (existing) {
      this.db
        .prepare(
          `UPDATE installed_plugins SET
             name = ?, version = ?, source = ?, source_ref = ?, manifest = ?,
             contributions = ?, enabled = ?, signature = ?, updated_at = ?
           WHERE namespace = ?`,
        )
        .run(
          input.name,
          input.version,
          input.source,
          jsonCol(input.source_ref, existing.source_ref),
          jsonCol(input.manifest, existing.manifest),
          jsonCol(input.contributions, existing.contributions),
          (input.enabled ?? existing.enabled) ? 1 : 0,
          input.signature !== undefined ? input.signature : existing.signature,
          now,
          input.namespace,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO installed_plugins
             (namespace, name, version, source, source_ref, manifest,
              contributions, enabled, signature, installed_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.namespace,
          input.name,
          input.version,
          input.source,
          jsonCol(input.source_ref, null),
          jsonCol(input.manifest, null),
          jsonCol(input.contributions, null),
          (input.enabled ?? true) ? 1 : 0,
          input.signature ?? null,
          now,
          now,
        );
    }
    return this.get(input.namespace)!;
  }

  setEnabled(namespace: string, enabled: boolean): void {
    this.db
      .prepare(
        `UPDATE installed_plugins SET enabled = ?, updated_at = datetime('now') WHERE namespace = ?`,
      )
      .run(enabled ? 1 : 0, namespace);
  }

  /** Persist the capability subset the user approved (JSON blob, or null). */
  setPermissionsGranted(namespace: string, granted: Record<string, unknown> | null): void {
    this.db
      .prepare(
        `UPDATE installed_plugins SET permissions_granted = ?, updated_at = datetime('now') WHERE namespace = ?`,
      )
      .run(granted ? JSON.stringify(granted) : null, namespace);
  }

  delete(namespace: string): void {
    this.db.prepare('DELETE FROM installed_plugins WHERE namespace = ?').run(namespace);
  }
}
