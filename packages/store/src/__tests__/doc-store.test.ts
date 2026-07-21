/**
 * Tests for the bits of `DocStore` whose SQL has tripped real bugs in
 * production logs. Smoke coverage for CRUD lives in route-level integration
 * tests; this file pins the specific invariants that have regressed:
 *
 *   - `tryAcquireSource` works with all-named parameters (previous bug:
 *     `?` mixed with `@named` → "Too few parameter values were provided"
 *     on every indexing attempt — see [doc-indexer] logs 2026-05-19)
 *   - Stale acquire window honors `staleAfterMs`
 *   - `recoverStaleSources` only touches in-flight rows
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../db.js';
import { DocStore } from '../doc-store.js';
import { SemanticStore } from '../semantic-store.js';

interface Handle {
  db: CodeIndexDB;
  store: DocStore;
  dir: string;
}

function setup(): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-doc-store-test-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  const store = new DocStore(db.raw());
  return { db, store, dir };
}

function recordSemanticVectors(h: Handle, collectionId: number, chunkIds: readonly number[]): void {
  const semantic = new SemanticStore(h.db.raw());
  const namespace = `docs:c${collectionId}`;
  let state = semantic.listNamespaceGenerations({ namespace })[0];
  let generationId = state?.active_generation_id ?? null;
  if (!generationId) {
    const generation = semantic.createGeneration({
      purpose: 'docs', fingerprint: 'docs:test',
      embedding_target: { kind: 'disabled' }, dimension: 3,
    });
    generationId = generation.id;
    semantic.updateGeneration(generationId, { status: 'ready' });
    semantic.beginNamespaceGeneration({
      namespace, purpose: 'docs', generation_id: generationId,
      expected_items: chunkIds.length,
    });
  }
  for (const chunkId of chunkIds) {
    semantic.upsertItem({
      generation_id: generationId, namespace,
      item_key: `doc_chunk:${chunkId}`, source_hash: `hash-${chunkId}`,
      vector_id: `doc_chunk:${chunkId}`, chunk_index: 0,
      status: 'indexed', attempts: 1, error: null,
    });
  }
  state = semantic.listNamespaceGenerations({ namespace })[0];
  if (state?.building_generation_id === generationId) {
    semantic.updateNamespaceProgress(namespace, {
      indexed_items: state.expected_items,
    });
    semantic.activateNamespaceGeneration(namespace, generationId);
  }
}

describe('DocStore.tryAcquireSource', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('flips a queued source to fetching and returns true', () => {
    const c = h.store.createCollection({ name: 'col-a' });
    const s = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://a.example' });
    expect(s.status).toBe('queued');

    const ok = h.store.tryAcquireSource(s.id);
    expect(ok).toBe(true);
    expect(h.store.getSource(s.id)?.status).toBe('fetching');
  });

  it('refuses to acquire a source already in fetching/indexing within the staleness window', () => {
    const c = h.store.createCollection({ name: 'col-b' });
    const s = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://b.example' });
    expect(h.store.tryAcquireSource(s.id)).toBe(true); // first acquire — flips to fetching
    expect(h.store.tryAcquireSource(s.id)).toBe(false); // second acquire — still in flight
  });

  it('allows acquire of a stale fetching source (older than the window)', () => {
    const c = h.store.createCollection({ name: 'col-c' });
    const s = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://c.example' });
    expect(h.store.tryAcquireSource(s.id)).toBe(true);

    // Backdate the updated_at 10 minutes — simulates a crashed run.
    h.db.raw()
      .prepare(`UPDATE doc_sources SET updated_at = datetime('now', '-10 minutes') WHERE id = ?`)
      .run(s.id);

    // 5-minute window → stale row qualifies again.
    expect(h.store.tryAcquireSource(s.id, 5 * 60 * 1000)).toBe(true);
  });

  it('returns false when the source row does not exist', () => {
    expect(h.store.tryAcquireSource(9999)).toBe(false);
  });
});

describe('DocStore vector cleanup helpers', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  /**
   * Insert chunks + persist their accepted embedding state so deterministic
   * vector-id helpers have something to find.
   */
  function seedChunksWithVectors(
    collectionId: number,
    sourceId: number,
    count: number,
    provider = 'default',
  ): string[] {
    const inputs = Array.from({ length: count }, (_, i) => ({
      collection_id: collectionId,
      source_id: sourceId,
      ord: i,
      heading_path: `s${i}`,
      content: `chunk ${i} content`,
      content_hash: `hash${i}`,
    }));
    const chunkIds = h.store.insertChunks(inputs);
    const vectorIds: string[] = [];
    for (const chunkId of chunkIds) {
      const vid = `doc_chunk:${chunkId}`;
      h.store.updateChunkEmbeddingState(chunkId, `hash-${chunkId}`, provider);
      vectorIds.push(vid);
    }
    recordSemanticVectors(h, collectionId, chunkIds);
    return vectorIds;
  }

  it('listVectorIdsForSource returns refs for all chunks of that source', () => {
    const c = h.store.createCollection({ name: 'col' });
    const s = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://a.example' });
    const expected = seedChunksWithVectors(c.id, s.id, 3);
    const refs = h.store.listVectorIdsForSource(s.id);
    expect(refs.map((r) => r.vector_id).sort()).toEqual(expected.sort());
    expect(refs.every((r) => r.provider.startsWith('semantic:g'))).toBe(true);
    expect(h.db.raw().prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'doc_chunk_vectors'`,
    ).get()).toBeUndefined();
    expect(h.store.countVectorMappings()).toBe(3);
  });

  it('listVectorIdsForCollection aggregates across multiple sources', () => {
    const c = h.store.createCollection({ name: 'col' });
    const s1 = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://a.example' });
    const s2 = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://b.example' });
    const a = seedChunksWithVectors(c.id, s1.id, 2);
    const b = seedChunksWithVectors(c.id, s2.id, 3);
    const refs = h.store.listVectorIdsForCollection(c.id);
    expect(refs.length).toBe(5);
    expect(refs.map((r) => r.vector_id).sort()).toEqual([...a, ...b].sort());
  });

  it('ignores the retired chunk embedding mirror when semantic_items has no vector', () => {
    const c = h.store.createCollection({ name: 'legacy-map' });
    const s = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://legacy.example' });
    const [chunkId] = h.store.insertChunks([
      { collection_id: c.id, source_id: s.id, ord: 0, content: 'legacy', content_hash: 'legacy' },
    ]);
    h.store.updateChunkEmbeddingState(chunkId, 'legacy-hash', 'legacy-fingerprint');

    expect(h.store.listVectorIdsForSource(s.id)).toEqual([]);
    expect(h.store.countVectorMappings()).toBe(0);
  });

});

describe('DocStore.recoverStaleSources', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('marks fetching/indexing rows as error, leaves done/queued alone', () => {
    const c = h.store.createCollection({ name: 'col' });
    const s1 = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://1.example' });
    const s2 = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://2.example' });
    const s3 = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://3.example' });
    const s4 = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://4.example' });

    h.store.updateSourceStatus(s1.id, 'fetching');
    h.store.updateSourceStatus(s2.id, 'indexing');
    h.store.updateSourceStatus(s3.id, 'done');
    // s4 stays queued

    const { recovered } = h.store.recoverStaleSources();
    expect(recovered).toBe(2);
    expect(h.store.getSource(s1.id)?.status).toBe('error');
    expect(h.store.getSource(s2.id)?.status).toBe('error');
    expect(h.store.getSource(s3.id)?.status).toBe('done');
    expect(h.store.getSource(s4.id)?.status).toBe('queued');
  });
});

describe('DocStore.getSourceHealth', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('returns null for unknown source', () => {
    expect(h.store.getSourceHealth(9999)).toBeNull();
  });

  it('reports embedding_complete=true when all chunks have vectors', () => {
    const c = h.store.createCollection({ name: 'col' });
    const s = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://x.example' });
    const inputs = Array.from({ length: 5 }, (_, i) => ({
      collection_id: c.id, source_id: s.id, ord: i, content: `c${i}`, content_hash: `h${i}`,
    }));
    const chunkIds = h.store.insertChunks(inputs);
    for (const id of chunkIds) h.store.updateChunkEmbeddingState(id, `hash-${id}`, 'default');
    recordSemanticVectors(h, c.id, chunkIds);

    const health = h.store.getSourceHealth(s.id)!;
    expect(health.chunks_persisted).toBe(5);
    expect(health.chunks_embedded).toBe(5);
    expect(health.embedding_complete).toBe(true);
    expect(health.missing_count).toBe(0);
  });

  it('reports drift when chunks have no accepted embedding hash', () => {
    // Exactly the scenario the user hit: 6331 persisted, 448 embedded.
    const c = h.store.createCollection({ name: 'col' });
    const s = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://x.example' });
    const inputs = Array.from({ length: 10 }, (_, i) => ({
      collection_id: c.id, source_id: s.id, ord: i, content: `c${i}`, content_hash: `h${i}`,
    }));
    const chunkIds = h.store.insertChunks(inputs);
    // Embed only the first 3.
    for (let i = 0; i < 3; i++) {
      h.store.updateChunkEmbeddingState(chunkIds[i]!, `hash-${chunkIds[i]}`, 'default');
    }
    recordSemanticVectors(h, c.id, chunkIds.slice(0, 3));

    const health = h.store.getSourceHealth(s.id)!;
    expect(health.chunks_persisted).toBe(10);
    expect(health.chunks_embedded).toBe(3);
    expect(health.embedding_complete).toBe(false);
    expect(health.missing_count).toBe(7);
  });

  it('zero chunks → embedding_complete=false (vacuous truth would mislead the UI badge)', () => {
    const c = h.store.createCollection({ name: 'col' });
    const s = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://x.example' });
    const health = h.store.getSourceHealth(s.id)!;
    expect(health.chunks_persisted).toBe(0);
    expect(health.chunks_embedded).toBe(0);
    expect(health.embedding_complete).toBe(false);
  });

  it('keeps vector counts source-scoped when a collection has multiple sources', () => {
    const c = h.store.createCollection({ name: 'multi-source' });
    const s1 = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://one.example' });
    const s2 = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://two.example' });
    const first = h.store.insertChunks(Array.from({ length: 2 }, (_, ord) => ({
      collection_id: c.id, source_id: s1.id, ord, content: `a${ord}`, content_hash: `a${ord}`,
    })));
    const second = h.store.insertChunks(Array.from({ length: 3 }, (_, ord) => ({
      collection_id: c.id, source_id: s2.id, ord, content: `b${ord}`, content_hash: `b${ord}`,
    })));
    recordSemanticVectors(h, c.id, [...first, ...second]);

    expect(h.store.getSourceHealth(s1.id)?.chunks_embedded).toBe(2);
    expect(h.store.getSourceHealth(s2.id)?.chunks_embedded).toBe(3);
  });
});

describe('DocStore.listChunksMissingEmbedding scoping', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('sourceId scope returns only that source\'s chunks', () => {
    const c = h.store.createCollection({ name: 'col' });
    const s1 = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://1.example' });
    const s2 = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://2.example' });
    h.store.insertChunks([
      { collection_id: c.id, source_id: s1.id, ord: 0, content: 'a', content_hash: 'ha' },
      { collection_id: c.id, source_id: s2.id, ord: 0, content: 'b', content_hash: 'hb' },
    ]);
    expect(h.store.listChunksMissingEmbedding({ sourceId: s1.id }).length).toBe(1);
    expect(h.store.listChunksMissingEmbedding({ sourceId: s2.id }).length).toBe(1);
  });

  it('sourceId beats collectionId when both passed', () => {
    const c = h.store.createCollection({ name: 'col' });
    const s = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://x.example' });
    const sOther = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://y.example' });
    h.store.insertChunks([
      { collection_id: c.id, source_id: s.id, ord: 0, content: 'a', content_hash: 'ha' },
      { collection_id: c.id, source_id: sOther.id, ord: 0, content: 'b', content_hash: 'hb' },
    ]);
    expect(h.store.listChunksMissingEmbedding({ sourceId: s.id, collectionId: c.id }).length).toBe(1);
  });

  it('no scope returns all missing across corpus', () => {
    const c1 = h.store.createCollection({ name: 'a' });
    const c2 = h.store.createCollection({ name: 'b' });
    const s1 = h.store.createSource({ collection_id: c1.id, type: 'url', uri: 'https://a.example' });
    const s2 = h.store.createSource({ collection_id: c2.id, type: 'url', uri: 'https://b.example' });
    h.store.insertChunks([
      { collection_id: c1.id, source_id: s1.id, ord: 0, content: 'a', content_hash: 'ha' },
      { collection_id: c2.id, source_id: s2.id, ord: 0, content: 'b', content_hash: 'hb' },
    ]);
    expect(h.store.listChunksMissingEmbedding().length).toBe(2);
  });
});
