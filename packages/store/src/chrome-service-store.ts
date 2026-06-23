/**
 * ChromeServiceStore — singleton row CRUD for the shared Chromium
 * container config. The `chrome_service_configs` table has a single
 * row (`CHECK(id = 1)`) seeded by migration 045; this store ensures
 * the row is always materialised on first read and exposes typed
 * accessors for the runtime (`ChromeService`) + the admin routes.
 *
 * Constructor follows the same dual-mode pattern as `SkillStore`,
 * `QaTestRunStore`: pass either a path (open + own connection) or a
 * shared `better-sqlite3` handle (no ownership).
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

export type ChromeServiceStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface ChromeServiceConfig {
  id: 1;
  enabled: boolean;
  image: string;
  host_port: number;
  status: ChromeServiceStatus;
  container_id: string | null;
  last_error: string | null;
  started_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChromeServicePatch {
  enabled?: boolean;
  image?: string;
  host_port?: number;
}

export interface ChromeServiceStatusUpdate {
  status: ChromeServiceStatus;
  container_id?: string | null;
  last_error?: string | null;
  started_at?: string | null;
}

interface RawRow {
  id: number;
  enabled: number;
  image: string;
  host_port: number;
  status: string;
  container_id: string | null;
  last_error: string | null;
  started_at: string | null;
  created_at: string;
  updated_at: string;
}

function hydrate(r: RawRow): ChromeServiceConfig {
  return {
    id: 1,
    enabled: !!r.enabled,
    image: r.image,
    host_port: r.host_port,
    status: r.status as ChromeServiceStatus,
    container_id: r.container_id,
    last_error: r.last_error,
    started_at: r.started_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export class ChromeServiceStore {
  private db: DB;
  private ownsConnection: boolean;

  constructor(dbPathOrHandle: string | DB) {
    if (typeof dbPathOrHandle === 'string') {
      this.db = new Database(dbPathOrHandle);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.ownsConnection = true;
    } else {
      this.db = dbPathOrHandle;
      this.ownsConnection = false;
    }
  }

  close(): void {
    if (this.ownsConnection) this.db.close();
  }

  /**
   * Read the singleton row. The migration seeds it on first install,
   * so this never returns null in practice — but we tolerate a missing
   * row (older test DBs, partial migration replay) by self-seeding.
   */
  getConfig(): ChromeServiceConfig {
    const row = this.db
      .prepare('SELECT * FROM chrome_service_configs WHERE id = 1')
      .get() as RawRow | undefined;
    if (row) return hydrate(row);
    // Defensive: re-seed and re-read.
    this.db
      .prepare('INSERT OR IGNORE INTO chrome_service_configs (id, enabled) VALUES (1, 0)')
      .run();
    const seeded = this.db
      .prepare('SELECT * FROM chrome_service_configs WHERE id = 1')
      .get() as RawRow;
    return hydrate(seeded);
  }

  /**
   * Apply a partial config update (operator-driven). Only the three
   * caller-editable fields are exposed here; status transitions go via
   * `setStatus` so we never accidentally clobber `container_id`.
   */
  patch(patch: ChromeServicePatch): ChromeServiceConfig {
    const sets: string[] = [];
    const params: Array<string | number> = [];
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(patch.enabled ? 1 : 0);
    }
    if (patch.image !== undefined) {
      sets.push('image = ?');
      params.push(patch.image);
    }
    if (patch.host_port !== undefined) {
      sets.push('host_port = ?');
      params.push(patch.host_port);
    }
    if (sets.length === 0) return this.getConfig();
    sets.push("updated_at = datetime('now')");
    this.db
      .prepare(`UPDATE chrome_service_configs SET ${sets.join(', ')} WHERE id = 1`)
      .run(...params);
    return this.getConfig();
  }

  /**
   * Persist a status transition. Pass `container_id: null` explicitly to
   * clear the field; omit it to leave the existing value alone. Same for
   * `last_error`.
   */
  setStatus(update: ChromeServiceStatusUpdate): ChromeServiceConfig {
    const sets: string[] = ['status = ?'];
    const params: Array<string | number | null> = [update.status];

    if (Object.prototype.hasOwnProperty.call(update, 'container_id')) {
      sets.push('container_id = ?');
      params.push(update.container_id ?? null);
    }
    if (Object.prototype.hasOwnProperty.call(update, 'last_error')) {
      sets.push('last_error = ?');
      params.push(update.last_error ?? null);
    }
    if (Object.prototype.hasOwnProperty.call(update, 'started_at')) {
      sets.push('started_at = ?');
      params.push(update.started_at ?? null);
    }
    sets.push("updated_at = datetime('now')");
    this.db
      .prepare(`UPDATE chrome_service_configs SET ${sets.join(', ')} WHERE id = 1`)
      .run(...params);
    return this.getConfig();
  }
}
