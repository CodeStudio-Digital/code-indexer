import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { appStudioImpactV5220 } from '../220_app_studio_impact_v5.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

describe('migration 220 — App Studio impact v5', () => {
  it('converts historical stage impacts in revisions and evolutions', () => {
    db.exec(`
      CREATE TABLE app_studio_spec_revisions (id INTEGER PRIMARY KEY, impact_json TEXT);
      CREATE TABLE app_studio_evolutions (id INTEGER PRIMARY KEY, impact_json TEXT);
    `);
    const legacy = JSON.stringify({
      level: 'high',
      stage_ids: ['architecture', 'database', 'design', 'backend', 'review'],
      reasons: ['Changed data'],
    });
    db.prepare('INSERT INTO app_studio_spec_revisions (id, impact_json) VALUES (1, ?)').run(legacy);
    db.prepare('INSERT INTO app_studio_evolutions (id, impact_json) VALUES (1, ?)').run(legacy);

    appStudioImpactV5220.up(db);

    for (const table of ['app_studio_spec_revisions', 'app_studio_evolutions']) {
      const row = db.prepare(`SELECT impact_json FROM ${table} WHERE id = 1`).get() as { impact_json: string };
      expect(JSON.parse(row.impact_json)).toEqual({
        level: 'high',
        affected_phases: ['blueprint', 'build', 'deliver'],
        source_ids: [],
        reasons: ['Changed data'],
      });
      expect(row.impact_json).not.toContain('stage_ids');
    }
  });

  it('is idempotent for canonical v5 impacts', () => {
    db.exec('CREATE TABLE app_studio_evolutions (id INTEGER PRIMARY KEY, impact_json TEXT)');
    const canonical = JSON.stringify({ level: 'medium', affected_phases: ['define', 'build'], source_ids: ['goal:1'], reasons: [] });
    db.prepare('INSERT INTO app_studio_evolutions (id, impact_json) VALUES (1, ?)').run(canonical);
    appStudioImpactV5220.up(db);
    appStudioImpactV5220.up(db);
    const row = db.prepare('SELECT impact_json FROM app_studio_evolutions WHERE id = 1').get() as { impact_json: string };
    expect(JSON.parse(row.impact_json)).toEqual(JSON.parse(canonical));
  });

  it('is a no-op for trimmed databases', () => {
    expect(() => appStudioImpactV5220.up(db)).not.toThrow();
  });
});
