/**
 * Migration 054 — Skill context_mode v2.
 *
 * Replaces the legacy `inline` context_mode with `auto`. The semantics are
 * stricter: an `auto` skill only appears in the system prompt when the
 * runtime matcher (skill-matcher.ts) considers it relevant for the current
 * session context (role, recent files, tags). Old `inline` skills were
 * always injected verbatim, polluting prompts with skills the agent never
 * needed.
 *
 * Existing rows are migrated 1:1 — every `inline` skill becomes an `auto`
 * skill, then the matcher decides per-session whether to surface it.
 *
 * The CHECK constraint is also tightened so future inserts cannot regress
 * back to `inline`. SQLite has no `ALTER TABLE ... ADD CONSTRAINT`, so the
 * constraint is enforced at write-time via `skill-store.ts` validation.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const skillContextModeV2 = {
  version: 54,
  name: 'skill_context_mode_v2',
  up(db: DB) {
    db.exec(`
      UPDATE skill_definitions
      SET context_mode = 'auto'
      WHERE context_mode = 'inline';
    `);
  },
};
