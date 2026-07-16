import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { semanticIndexing227 } from '../227_semantic_indexing.js';
import { semanticLocalQ8Auto230 } from '../230_semantic_local_q8_auto.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

describe('migration 230 — managed local q8 and auto reranker', () => {
  it('upgrades only managed legacy defaults and leaves generations immutable', () => {
    semanticIndexing227.up(db);
    const legacyEmbedding = {
      kind: 'onnx', model: 'Xenova/multilingual-e5-small', pooling: 'mean', normalize: true,
      queryTemplate: 'query: {text}', documentTemplate: 'passage: {text}',
    };
    const legacyReranker = { kind: 'onnx', model: 'Xenova/bge-reranker-base' };
    db.prepare(`UPDATE semantic_profiles SET embedding_target=?, reranker_target=? WHERE purpose='code'`)
      .run(JSON.stringify(legacyEmbedding), JSON.stringify(legacyReranker));
    db.prepare(`
      INSERT INTO semantic_generations
        (purpose, fingerprint, embedding_target, dimension, status)
      VALUES ('code', 'old-space', ?, 384, 'ready')
    `).run(JSON.stringify(legacyEmbedding));

    semanticLocalQ8Auto230.up(db);

    const profile = db.prepare(`SELECT embedding_target, reranker_target FROM semantic_profiles WHERE purpose='code'`)
      .get() as { embedding_target: string; reranker_target: string };
    expect(JSON.parse(profile.embedding_target)).toMatchObject({ dtype: 'q8' });
    expect(JSON.parse(profile.reranker_target)).toMatchObject({ model: 'auto', dtype: 'q8' });
    const generation = db.prepare(`SELECT fingerprint, embedding_target FROM semantic_generations`).get() as unknown as {
      fingerprint: string;
      embedding_target: string;
    };
    expect(generation.fingerprint).toBe('old-space');
    expect(JSON.parse(generation.embedding_target)).not.toHaveProperty('dtype');
  });

  it('is safe on a trimmed/project database without semantic tables', () => {
    expect(() => semanticLocalQ8Auto230.up(db)).not.toThrow();
  });
});
