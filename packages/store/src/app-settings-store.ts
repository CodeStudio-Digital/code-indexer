/**
 * AppSettingsStore — DB-backed adapter for the env-var catalog.
 *
 * Resolution order on read (`get(key)`):
 *   1. DB row (operator saved a value) — authoritative.
 *   2. Inherited deployment/.env value before the first DB override.
 *   3. Catalog default.
 *
 * **NOT** queried at every `process.env.X` read site — that would be a
 * huge refactor. Instead, `applyToProcessEnv()` runs once at boot and
 * copies every DB row into `process.env`. Subsequent `set(...)` calls
 * mutate `process.env[key]` synchronously so code that re-reads gets
 * the new value without a restart.
 *
 * Caveats:
 *   - Cached env reads at module-load time (e.g., a `const PORT =
 *     Number(process.env.MCP_API_PORT)` at the top of a file) WON'T
 *     update without a restart. Catalog entries that fall into that
 *     pattern are marked `restartNeeded: true` so the UI warns.
 *   - Secrets are stored unencrypted because the SQLite DB is single-
 *     user and lives in the user profile dir; threat model is "same as
 *     a `.env`". If we ever go multi-user we'll need to wrap with the
 *     same crypto provider keys already use.
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import { APP_SETTINGS, getSettingDef, type SettingDef } from './app-settings-catalog.js';
import { normalizeSettingUpdates, normalizeSettingValue } from './app-settings-validation.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

// Capture only keys actually overridden, before the first assignment. All store
// instances in this process share the original deployment/.env fallback.
const inheritedEnv = new Map<string, string | undefined>();
const restartPending = new Set<string>();
export function settingsRestartRequired(): boolean { return restartPending.size > 0; }
function publishSetting(key: string, value: string | null): void {
  if (!inheritedEnv.has(key)) inheritedEnv.set(key, process.env[key]);
  const next = value ?? inheritedEnv.get(key);
  if (next === undefined) delete process.env[key];
  else process.env[key] = next;
}
export function inheritedSettingsEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const [key, value] of inheritedEnv) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

export interface AppSettingRow {
  key: string;
  value: string | null;
  updated_at: string;
}

export interface ResolvedSetting {
  def: SettingDef;
  /** Value from the DB if present; otherwise null. */
  storedValue: string | null;
  /** Effective value = stored ?? process.env ?? catalog default. */
  effectiveValue: string | null;
  /** Where the effective value came from — drives the UI badge. */
  source: 'db' | 'env' | 'default' | 'unset';
  updatedAt: string | null;
  validationError?: string;
}

export class AppSettingsStore {
  private readonly db: DB;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
  }

  /**
   * Push every DB-stored value into `process.env` so the rest of the
   * codebase keeps reading via `process.env.X` without refactor. Run
   * exactly once during `createApp()` BEFORE anything reads its first
   * `process.env`. Subsequent edits via `set()` keep `process.env` in
   * sync incrementally.
   */
  applyToProcessEnv(): { applied: number } {
    const rows = this.db
      .prepare<[], AppSettingRow>('SELECT key, value, updated_at FROM app_settings WHERE value IS NOT NULL')
      .all();
    let applied = 0;
    for (const row of rows) {
      if (row.value === null) continue;
      // Only assign for keys we know about — silently ignore strays so
      // a stale row after a catalog rename doesn't poison process.env.
      const def = getSettingDef(row.key);
      if (!def) continue;
      let value: string | null;
      try { value = normalizeSettingValue(def, row.value); }
      catch { continue; } // Older invalid rows remain editable, but never poison runtime.
      publishSetting(row.key, value);
      applied++;
    }
    return { applied };
  }

  /** Get the raw stored value (null if no row). */
  getRaw(key: string): string | null {
    const row = this.db
      .prepare<[string], { value: string | null }>('SELECT value FROM app_settings WHERE key = ?')
      .get(key);
    return row ? row.value : null;
  }

  /**
   * Resolve a single setting end-to-end: stored value + the effective
   * value the runtime would see + provenance label. Used by the admin
   * GET endpoint.
   */
  resolve(key: string): ResolvedSetting | null {
    const def = getSettingDef(key);
    if (!def) return null;
    const row = this.db
      .prepare<[string], AppSettingRow>('SELECT key, value, updated_at FROM app_settings WHERE key = ?')
      .get(key);
    const stored = row?.value ?? null;
    let validStored: string | null = null;
    let validationError: string | undefined;
    try { validStored = normalizeSettingValue(def, stored); }
    catch { validationError = 'invalid_stored_value'; }
    const envValue = inheritedEnv.has(key) ? inheritedEnv.get(key) : process.env[key];
    let effective: string | null;
    let source: ResolvedSetting['source'];
    if (validStored !== null) {
      effective = validStored;
      source = 'db';
    } else if (envValue !== undefined && envValue !== '') {
      effective = envValue;
      source = 'env';
    } else if (def.default !== undefined) {
      effective = def.default;
      source = 'default';
    } else {
      effective = null;
      source = 'unset';
    }
    return {
      def,
      storedValue: stored,
      effectiveValue: effective,
      source,
      updatedAt: row?.updated_at ?? null,
      ...(validationError ? { validationError } : {}),
    };
  }

  /** Resolve every catalog entry in declaration order. */
  resolveAll(): ResolvedSetting[] {
    return APP_SETTINGS.map((def) => this.resolve(def.key)!);
  }

  /**
   * Persist a setting AND mutate `process.env` so subsequent reads in
   * this process see the new value. Pass `value = null` to clear the
   * row (reverts to env/default fallback).
   *
   * Caller is responsible for knowing whether the change is
   * hot-applicable — for `restartNeeded` settings we still update
   * `process.env`, but cached values in modules won't refresh until
   * restart. The UI surfaces this with a "Restart needed" pill.
   */
  set(key: string, value: string | null): void {
    this.setMany({ [key]: value });
  }

  /** Validate the complete batch and commit atomically before publishing env. */
  setMany(updates: Record<string, unknown>, validate?: (updates: Record<string, string | null>) => void): void {
    const normalized = normalizeSettingUpdates(updates);
    validate?.(normalized);
    const remove = this.db.prepare('DELETE FROM app_settings WHERE key = ?');
    const upsert = this.db.prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(normalized)) {
        if (value === null) remove.run(key);
        else upsert.run(key, value);
      }
    })();
    for (const [key, value] of Object.entries(normalized)) {
      const previous = process.env[key];
      publishSetting(key, value);
      if (getSettingDef(key)?.restartNeeded && previous !== process.env[key]) restartPending.add(key);
    }
  }

  close(): void {
    this.db.close();
  }
}
