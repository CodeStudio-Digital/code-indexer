/**
 * Migration 033 — Track external source of third-party skills.
 *
 * Adds `source_ref` (JSON) to `skill_definitions`, holding the provenance
 * of skills installed from external repos (e.g. cloudflare/skills). The
 * JSON shape is `{ repo, commit, path }`. Built-in and user-authored
 * skills leave the column NULL.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const skillSourceRef033 = {
  version: 33,
  name: 'skill_source_ref',
  up(db: DB) {
    db.exec(`ALTER TABLE skill_definitions ADD COLUMN source_ref TEXT;`);
  },
};
