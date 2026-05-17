/**
 * Migration 055 — Skill triggers (path + role).
 *
 * Adds two new columns to `skill_definitions`:
 *   - `trigger_paths` TEXT (JSON array of glob patterns) — replaces the
 *      pre-existing `path_patterns` field, which is left in place for
 *      backwards-compat but no longer read by the matcher.
 *   - `trigger_roles` TEXT (JSON array of subordinate role names) — new.
 *      Lets a builtin skill declare it should auto-load whenever a
 *      subordinate is spawned with a matching role (e.g. `ds-extractor`
 *      → `[extractor]`, `ds-storybook` → `[storybook-builder]`).
 *
 * The runtime resolver (`skill-matcher.ts` introduced in B2) consults
 * these columns to decide which skills to inject into a session's system
 * prompt. Empty / NULL values mean "no auto-trigger" — the skill is still
 * discoverable via `get_skills_list` and the slash command, just not
 * pre-loaded.
 *
 * Existing `path_patterns` values are copied into `trigger_paths` so
 * builtin skills installed before this migration keep their previous
 * behaviour after upgrading.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const skillTrigger = {
  version: 55,
  name: 'skill_trigger',
  up(db: DB) {
    db.exec(`
      ALTER TABLE skill_definitions ADD COLUMN trigger_paths TEXT;
      ALTER TABLE skill_definitions ADD COLUMN trigger_roles TEXT;

      UPDATE skill_definitions
      SET trigger_paths = path_patterns
      WHERE path_patterns IS NOT NULL AND trigger_paths IS NULL;
    `);
  },
};
