import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { coderInvestigations126 } from '../126_coder_investigations.js';
import { investigationEmbedding127 } from '../127_investigation_embedding.js';
import { investigationEmbeddingFingerprint228 } from '../228_investigation_embedding_fingerprint.js';
import { distributeInvestigationVectors229 } from '../229_distribute_investigation_vectors.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

function columns(): string[] {
  return (db.prepare('PRAGMA table_info(coder_investigations)').all() as Array<{ name: string }>)
    .map((row) => row.name);
}

describe('migration 229 — distributed investigation vectors', () => {
  it('is guarded for trimmed project databases', () => {
    expect(() => distributeInvestigationVectors229.up(db)).not.toThrow();
    expect(columns()).toEqual([]);
  });

  it('preserves text/metadata and discards central vector columns without copying', () => {
    coderInvestigations126.up(db);
    investigationEmbedding127.up(db);
    investigationEmbeddingFingerprint228.up(db);
    db.prepare(`
      INSERT INTO coder_investigations
        (id, project_id, session_id, topic, summary, body, source_label,
         agent_type, tokens, created_at, embedding, embedding_fingerprint)
      VALUES (7, 2, 9, 'routing', 'per-project vectors', 'details', 'Explore',
              'explore', 123, '2026-07-15 10:00:00', X'0000803F', 'old-space')
    `).run();

    distributeInvestigationVectors229.up(db);

    expect(columns()).toEqual([
      'id', 'project_id', 'session_id', 'topic', 'summary', 'body',
      'source_label', 'agent_type', 'tokens', 'created_at',
    ]);
    expect(db.prepare('SELECT * FROM coder_investigations WHERE id = 7').get()).toEqual({
      id: 7,
      project_id: 2,
      session_id: 9,
      topic: 'routing',
      summary: 'per-project vectors',
      body: 'details',
      source_label: 'Explore',
      agent_type: 'explore',
      tokens: 123,
      created_at: '2026-07-15 10:00:00',
    });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name LIKE 'idx_coder_investigations_%'
      ORDER BY name
    `).all()).toEqual([
      { name: 'idx_coder_investigations_project' },
      { name: 'idx_coder_investigations_session' },
    ]);

    db.prepare(`
      INSERT INTO coder_investigations
        (project_id, session_id, topic, summary)
      VALUES (2, 10, 'next', 'fresh')
    `).run();
    expect((db.prepare('SELECT MAX(id) AS id FROM coder_investigations').get() as { id: number }).id)
      .toBe(8);
  });
});
