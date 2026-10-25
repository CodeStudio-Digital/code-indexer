import type { Migration } from './types.js';

/** Retire the shipped workflow instructions without deleting projects or history. */
export const retireAppStudioSkill270: Migration = {
  version: 270,
  name: 'retire_app_studio_skill',
  up(db) {
    const hasSkills = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'skill_definitions'",
    ).get();
    if (hasSkills) {
      db.prepare("DELETE FROM skill_definitions WHERE id = 'cloudflare-app' AND source = 'builtin'").run();
    }
  },
};
