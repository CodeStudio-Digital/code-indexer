/**
 * Migration 164 — drop the dead session-split scaffolding.
 *
 * Migration 161 created `coder_session_index` (a central session→project DB
 * pointer) and `project_cost_rollup` (a denormalized billing aggregate) for a
 * per-project SESSION split. That split was CANCELLED: sessions + telemetry +
 * costs + runs stay CENTRAL (faithful platform stats, chat core untouched). Both
 * tables are now confirmed dead (no reader/writer remains), so we drop them to
 * keep the central DB clean — no leftover junk tables.
 *
 * KEPT: `projects.db_split_*` (active index routing markers, mig 161) and
 * `coder_turn_telemetry.project_id` (mig 162 — used by the split-completion
 * canary + per-project stats).
 *
 * Idempotent (`DROP TABLE IF EXISTS`). No inbound FKs, so no table recreation /
 * `outsideTransaction` needed.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const dropSessionSplitScaffolding164: Migration = {
  version: 164,
  name: 'drop_session_split_scaffolding',
  up: (db: DB): void => {
    db.exec(`DROP TABLE IF EXISTS coder_session_index;`);
    db.exec(`DROP TABLE IF EXISTS project_cost_rollup;`);
  },
};
