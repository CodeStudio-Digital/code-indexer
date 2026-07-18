import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { splitSemanticKnowledge238 } from '../238_split_semantic_knowledge.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function legacyDb(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE semantic_profiles (
      purpose TEXT PRIMARY KEY CHECK (purpose IN ('code', 'knowledge')),
      embedding_target TEXT NOT NULL CHECK (json_valid(embedding_target)),
      reranker_target TEXT NOT NULL CHECK (json_valid(reranker_target)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE semantic_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purpose TEXT NOT NULL CHECK (purpose IN ('code', 'knowledge')),
      fingerprint TEXT NOT NULL,
      embedding_target TEXT NOT NULL CHECK (json_valid(embedding_target)),
      dimension INTEGER NOT NULL CHECK (dimension > 0),
      status TEXT NOT NULL DEFAULT 'building' CHECK (status IN ('building','ready','failed','retired')),
      expected_items INTEGER NOT NULL DEFAULT 0,
      indexed_items INTEGER NOT NULL DEFAULT 0,
      failed_items INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX idx_semantic_generations_status ON semantic_generations(purpose, status, id DESC);
    CREATE INDEX idx_semantic_generations_fingerprint ON semantic_generations(purpose, fingerprint, id DESC);
    CREATE TABLE semantic_namespace_generations (
      namespace TEXT PRIMARY KEY,
      purpose TEXT NOT NULL CHECK (purpose IN ('code', 'knowledge')),
      active_generation_id INTEGER REFERENCES semantic_generations(id) ON DELETE SET NULL,
      building_generation_id INTEGER REFERENCES semantic_generations(id) ON DELETE SET NULL,
      expected_items INTEGER NOT NULL DEFAULT 0,
      indexed_items INTEGER NOT NULL DEFAULT 0,
      failed_items INTEGER NOT NULL DEFAULT 0,
      delta_items INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (active_generation_id IS NULL OR active_generation_id != building_generation_id)
    );
    CREATE INDEX idx_semantic_namespace_purpose ON semantic_namespace_generations(purpose, updated_at DESC);
    CREATE TABLE semantic_items (
      generation_id INTEGER NOT NULL REFERENCES semantic_generations(id) ON DELETE CASCADE,
      namespace TEXT NOT NULL,
      item_key TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      vector_id TEXT,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (generation_id, namespace, item_key, chunk_index)
    );
    CREATE TABLE semantic_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      generation_id INTEGER REFERENCES semantic_generations(id) ON DELETE CASCADE,
      namespace TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 0,
      cursor TEXT,
      expected_items INTEGER NOT NULL DEFAULT 0,
      processed_items INTEGER NOT NULL DEFAULT 0,
      failed_items INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
  `);
  return db;
}

describe('migration 238 - split semantic knowledge', () => {
  it('preserves code and source-independent state while resetting docs/memory generations', () => {
    const db = legacyDb();
    const local = JSON.stringify({ kind: 'onnx', model: 'code' });
    const remote = JSON.stringify({
      kind: 'provider', providerId: 'openrouter', model: 'nemotron', protocol: 'openai-embeddings',
    });
    const reranker = JSON.stringify({ kind: 'disabled' });
    db.prepare('INSERT INTO semantic_profiles (purpose, embedding_target, reranker_target) VALUES (?,?,?)')
      .run('code', local, reranker);
    db.prepare('INSERT INTO semantic_profiles (purpose, embedding_target, reranker_target) VALUES (?,?,?)')
      .run('knowledge', remote, reranker);
    const insertGeneration = db.prepare(`
      INSERT INTO semantic_generations
        (id,purpose,fingerprint,embedding_target,dimension,status,expected_items,indexed_items)
      VALUES (?,?,?,?,?,?,?,?)
    `);
    insertGeneration.run(4, 'code', 'code-fp', local, 3, 'ready', 1, 1);
    insertGeneration.run(7, 'knowledge', 'old-knowledge-fp', remote, 4, 'building', 47_604, 6_208);
    const insertNamespace = db.prepare(`
      INSERT INTO semantic_namespace_generations
        (namespace,purpose,active_generation_id,building_generation_id,expected_items,indexed_items)
      VALUES (?,?,?,?,?,?)
    `);
    insertNamespace.run('code:p2', 'code', 4, null, 1, 1);
    insertNamespace.run('docs:c11', 'knowledge', null, 7, 47_604, 6_208);
    insertNamespace.run('memory:project:p2', 'knowledge', null, 7, 59, 0);
    db.prepare(`
      INSERT INTO semantic_items (generation_id,namespace,item_key,source_hash,status)
      VALUES (?,?,?,?,?)
    `).run(4, 'code:p2', 'file:a.ts', 'code-hash', 'indexed');
    db.prepare(`
      INSERT INTO semantic_items (generation_id,namespace,item_key,source_hash,status)
      VALUES (?,?,?,?,?)
    `).run(7, 'docs:c11', 'doc_chunk:1', 'docs-hash', 'indexed');
    db.prepare(`INSERT INTO semantic_jobs (generation_id,namespace,kind) VALUES (?,?,?)`)
      .run(7, 'memory:project:p2', 'delta');

    splitSemanticKnowledge238.up(db);

    expect(db.prepare('SELECT purpose FROM semantic_profiles ORDER BY purpose').all())
      .toEqual([{ purpose: 'code' }, { purpose: 'docs' }, { purpose: 'memory' }]);
    expect(db.prepare("SELECT embedding_target FROM semantic_profiles WHERE purpose='docs'").get())
      .toEqual({ embedding_target: remote });
    expect(db.prepare("SELECT embedding_target FROM semantic_profiles WHERE purpose='memory'").get())
      .toEqual({ embedding_target: remote });
    expect(db.prepare('SELECT id,purpose FROM semantic_generations ORDER BY id').all())
      .toEqual([{ id: 4, purpose: 'code' }]);
    expect(db.prepare('SELECT namespace,purpose FROM semantic_namespace_generations').all())
      .toEqual([{ namespace: 'code:p2', purpose: 'code' }]);
    expect(db.prepare('SELECT generation_id,namespace FROM semantic_items').all())
      .toEqual([{ generation_id: 4, namespace: 'code:p2' }]);
    expect(db.prepare('SELECT COUNT(1) AS count FROM semantic_jobs').get()).toEqual({ count: 0 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('is a no-op for an already split schema', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE semantic_profiles (
        purpose TEXT PRIMARY KEY CHECK (purpose IN ('code','docs','memory')),
        embedding_target TEXT NOT NULL,
        reranker_target TEXT NOT NULL
      )
    `);
    expect(() => splitSemanticKnowledge238.up(db)).not.toThrow();
    db.close();
  });
});
