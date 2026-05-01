/**
 * Migration 052 — Rich model metadata on `provider_models`.
 *
 * The ChatGPT/Codex backend now exposes `/models` with a payload that
 * carries far more than `slug` + `display_name`: reasoning levels,
 * availability per plan, visibility, apply_patch tool variant, etc.
 *
 * This migration adds nullable columns so providers that don't have
 * this metadata simply leave them as NULL. JSON-shaped fields are
 * stored as TEXT (callers parse on read).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const providerModelMetadata052: Migration = {
  version: 52,
  name: 'provider_model_metadata',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'provider_models', 'display_name', 'TEXT');
    addColumnIfMissing(db, 'provider_models', 'description', 'TEXT');
    addColumnIfMissing(db, 'provider_models', 'default_reasoning_level', 'TEXT');
    addColumnIfMissing(db, 'provider_models', 'supported_reasoning_levels', 'TEXT');
    addColumnIfMissing(db, 'provider_models', 'apply_patch_tool_type', 'TEXT');
    addColumnIfMissing(db, 'provider_models', 'available_in_plans', 'TEXT');
    addColumnIfMissing(db, 'provider_models', 'minimal_client_version', 'TEXT');
    addColumnIfMissing(db, 'provider_models', 'visibility', 'TEXT');
    addColumnIfMissing(db, 'provider_models', 'supported_in_api', 'INTEGER');
    addColumnIfMissing(db, 'provider_models', 'input_modalities', 'TEXT');
  },
};
