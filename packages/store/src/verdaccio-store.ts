/**
 * VerdaccioStore — singleton-row CRUD for the embedded Verdaccio
 * registry config (migration 049).
 *
 * Same dual-mode constructor pattern as `ChromeServiceStore`. The single
 * row is seeded by migration 049 (`CHECK(id = 1)`).
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

export type VerdaccioStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface VerdaccioConfig {
  id: 1;
  enabled: boolean;
  image: string;
  host_port: number;
  status: VerdaccioStatus;
  container_id: string | null;
  last_error: string | null;
  upstream_token: string | null;
  /**
   * Persisted password for the auto-bootstrapped `dsadmin` user
   * (migration 050). Reused on every `enable()` so PUT acts as either
   * "create user" (fresh storage) or "login" (existing user) — without
   * persistence, a fresh random password collides with the existing
   * htpasswd entry and Verdaccio rejects the call as 401 unauthorized.
   */
  bootstrap_password: string | null;
  storage_path: string | null;
  max_patch_versions_per_minor: number;
  started_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface VerdaccioPatch {
  enabled?: boolean;
  image?: string;
  host_port?: number;
  upstream_token?: string | null;
  bootstrap_password?: string | null;
  storage_path?: string | null;
  max_patch_versions_per_minor?: number;
}

export interface VerdaccioStatusUpdate {
  status: VerdaccioStatus;
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
  upstream_token: string | null;
  bootstrap_password: string | null;
  storage_path: string | null;
  max_patch_versions_per_minor: number;
  started_at: string | null;
  created_at: string;
  updated_at: string;
}

function hydrate(r: RawRow): VerdaccioConfig {
  return {
    id: 1,
    enabled: !!r.enabled,
    image: r.image,
    host_port: r.host_port,
    status: r.status as VerdaccioStatus,
    container_id: r.container_id,
    last_error: r.last_error,
    upstream_token: r.upstream_token,
    bootstrap_password: r.bootstrap_password,
    storage_path: r.storage_path,
    max_patch_versions_per_minor: r.max_patch_versions_per_minor,
    started_at: r.started_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export class VerdaccioStore {
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

  getConfig(): VerdaccioConfig {
    const row = this.db
      .prepare('SELECT * FROM verdaccio_configs WHERE id = 1')
      .get() as RawRow | undefined;
    if (row) return hydrate(row);
    this.db
      .prepare('INSERT OR IGNORE INTO verdaccio_configs (id, enabled) VALUES (1, 0)')
      .run();
    const seeded = this.db
      .prepare('SELECT * FROM verdaccio_configs WHERE id = 1')
      .get() as RawRow;
    return hydrate(seeded);
  }

  patch(patch: VerdaccioPatch): VerdaccioConfig {
    const sets: string[] = [];
    const params: Array<string | number | null> = [];

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
    if (Object.prototype.hasOwnProperty.call(patch, 'upstream_token')) {
      sets.push('upstream_token = ?');
      params.push(patch.upstream_token ?? null);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'bootstrap_password')) {
      sets.push('bootstrap_password = ?');
      params.push(patch.bootstrap_password ?? null);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'storage_path')) {
      sets.push('storage_path = ?');
      params.push(patch.storage_path ?? null);
    }
    if (patch.max_patch_versions_per_minor !== undefined) {
      sets.push('max_patch_versions_per_minor = ?');
      params.push(patch.max_patch_versions_per_minor);
    }

    if (sets.length === 0) return this.getConfig();
    sets.push("updated_at = datetime('now')");
    this.db
      .prepare(`UPDATE verdaccio_configs SET ${sets.join(', ')} WHERE id = 1`)
      .run(...params);
    return this.getConfig();
  }

  setStatus(update: VerdaccioStatusUpdate): VerdaccioConfig {
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
      .prepare(`UPDATE verdaccio_configs SET ${sets.join(', ')} WHERE id = 1`)
      .run(...params);
    return this.getConfig();
  }
}
