/**
 * Migration 105 — generic `app_settings` key/value store.
 *
 * Goal: stop forcing end-users to edit a `.env` file to tune the
 * IDE. Every setting we'd previously read straight from `process.env`
 * now has a row here, surfaced in the admin "Configurações" section
 * and hot-applied to `process.env` when the operator saves.
 *
 * Schema is intentionally minimal — the catalog (label / description /
 * type / restart-needed flag / category) lives in code
 * (`packages/store/src/app-settings-catalog.ts`) so we don't have to
 * write migrations every time we add a knob. The DB only stores the
 * mutable bits: the current value, when it was last touched, and the
 * resolved source (so we can show "from .env" vs "from admin" in the UI).
 *
 * Note: we do NOT seed every catalog entry on migration. Empty rows
 * would just shadow the legacy `process.env` fallback and force the
 * admin UI to display defaults as "saved values", which is confusing.
 * Instead, the catalog declares defaults inline and the SettingStore
 * resolves: DB row → process.env → catalog default. A row appears only
 * after the operator explicitly saves.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const appSettings105: Migration = {
  version: 105,
  name: 'app_settings',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key         TEXT PRIMARY KEY,
        value       TEXT,
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  },
};
