/**
 * Migration 135 — Per-model tool-catalog cap + visible-tools telemetry.
 *
 * `provider_models.max_tools` is the admin-set override for how many tools
 * the coder ships to that model per turn (NULL = use the static
 * MODEL_REGISTRY / prefix fallbacks). Weak models (GLM flash class) degrade
 * above ~30 tools; this lets the admin calibrate without env vars.
 *
 * `coder_turn_telemetry.visible_tools_count` records how many tools were
 * actually visible on each turn so trim pressure per model is queryable
 * alongside the existing `tools_def_chars`.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const modelMaxTools135: Migration = {
  version: 135,
  name: 'model_max_tools',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'provider_models', 'max_tools', 'INTEGER');
    addColumnIfMissing(db, 'coder_turn_telemetry', 'visible_tools_count', 'INTEGER');
  },
};
