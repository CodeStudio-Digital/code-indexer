import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { retireAppStudioSkill270 } from '../270_retire_app_studio_skill.js';

describe('App Studio skill retirement', () => {
  it.each(['builtin', 'user'])('only removes the shipped skill, preserving %s data', (source) => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE skill_definitions (id TEXT PRIMARY KEY, source TEXT);
        CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE app_studio_sessions (id INTEGER PRIMARY KEY, name TEXT);
        INSERT INTO skill_definitions VALUES ('other-skill', 'builtin');
        INSERT INTO projects VALUES (1, 'Saved project');
        INSERT INTO app_studio_sessions VALUES (1, 'Saved App history');
      `);
      db.prepare('INSERT INTO skill_definitions VALUES (?, ?)').run('cloudflare-app', source);
      retireAppStudioSkill270.up(db);
      retireAppStudioSkill270.up(db);
      expect(db.prepare("SELECT source FROM skill_definitions WHERE id = 'cloudflare-app'").get())
        .toEqual(source === 'builtin' ? undefined : { source: 'user' });
      expect(db.prepare("SELECT id FROM skill_definitions WHERE id = 'other-skill'").get()).toBeDefined();
      expect(db.prepare('SELECT * FROM projects').all()).toEqual([{ id: 1, name: 'Saved project' }]);
      expect(db.prepare('SELECT * FROM app_studio_sessions').all()).toEqual([{ id: 1, name: 'Saved App history' }]);
    } finally {
      db.close();
    }
  });
});
