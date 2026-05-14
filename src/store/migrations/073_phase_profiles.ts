/**
 * Migration 073 — Phase profiles for the multi-model PhaseRouter (Camada 2).
 *
 * A "phase profile" maps each phase of an agent turn (triage / search / plan /
 * patch / finalize / review) to a (provider, model) pair. The runner's
 * PhaseRouter consults the resolved profile each turn boundary and calls
 * provider.setModel() to swap models without breaking prompt caching.
 *
 * Resolution cascade (mirrors subagent_target):
 *   session.phase_profile_id  →  role.phase_profile_id (company)
 *   →  project.default_phase_profile_id  →  global default  →  legacy single-model
 *
 * Schema:
 *   - coder_phase_profiles: the profile rows (mapping JSON, scope, label).
 *   - coder_sessions.phase_profile_id: per-session override (nullable FK).
 *
 * Mapping JSON shape:
 *   { triage?:   { provider, model },
 *     search?:   { provider, model },
 *     plan?:     { provider, model },
 *     patch?:    { provider, model },
 *     finalize?: { provider, model },
 *     review?:   { provider, model } }
 *
 * Phases without an entry fall back to session.provider/model — so a profile
 * can override only the phases the operator cares about (e.g. just triage to
 * Haiku) without listing the rest.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function columnExists(db: DB, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

export const phaseProfiles073: Migration = {
  version: 73,
  name: 'phase_profiles',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coder_phase_profiles (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL,
        description   TEXT,
        scope_type    TEXT NOT NULL DEFAULT 'global',
        scope_id      INTEGER,
        mapping_json  TEXT NOT NULL,
        is_default    INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_coder_phase_profiles_scope ON coder_phase_profiles(scope_type, scope_id);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_coder_phase_profiles_default ON coder_phase_profiles(is_default);`);

    // Per-session override pointer.
    if (!columnExists(db, 'coder_sessions', 'phase_profile_id')) {
      db.exec(`ALTER TABLE coder_sessions ADD COLUMN phase_profile_id INTEGER`);
    }
  },
};
