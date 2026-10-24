import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { semanticJobLookup268 } from '../268_semantic_job_lookup.js';

describe('migration 268 - central semantic job lookup', () => {
  it('does not recreate a central table in an existing project database', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE project_fixture (id INTEGER PRIMARY KEY, content TEXT)');
      db.prepare('INSERT INTO project_fixture VALUES (?, ?)').run(1, 'preserve existing project');
      expect(() => semanticJobLookup268.up(db)).not.toThrow();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='semantic_jobs'").get()).toBeUndefined();
      expect(db.prepare('SELECT content FROM project_fixture').get()).toEqual({ content: 'preserve existing project' });
    } finally { db.close(); }
  });

  it('creates the central index idempotently while retaining queued jobs', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE semantic_jobs (id INTEGER PRIMARY KEY, namespace TEXT, kind TEXT, status TEXT)');
      db.prepare('INSERT INTO semantic_jobs VALUES (1, ?, ?, ?)').run('code:1', 'delta', 'pending');
      semanticJobLookup268.up(db); semanticJobLookup268.up(db);
      const columns = db.prepare("PRAGMA index_info('idx_semantic_jobs_namespace_kind_status')").all() as Array<{ name: string }>;
      expect(columns.map(c => c.name)).toEqual(['namespace', 'kind', 'status', 'id']);
      expect(db.prepare('SELECT * FROM semantic_jobs').all()).toEqual([{ id: 1, namespace: 'code:1', kind: 'delta', status: 'pending' }]);
    } finally { db.close(); }
  });
});
