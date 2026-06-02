/**
 * Empirical coverage for the embedded sqlite-vec vector store. Runs real
 * sqlite-vec (vec0) under Node — verifies the version-specific KNN + metadata
 * filter SQL actually behaves, not just that it type-checks.
 */
import { describe, it, expect } from 'vitest';
import { SqliteVecVectorStore } from '../sqlite-vec-store.js';
import type { VectorRecord } from '@mcp/shared/types.js';

function rec(id: string, values: number[], meta: Record<string, string>): VectorRecord {
  return { id, values, metadata: meta };
}

describe('SqliteVecVectorStore', () => {
  it('upserts, KNN-searches with a metadata filter, overwrites, and deletes', async () => {
    const store = new SqliteVecVectorStore({ path: ':memory:' });
    await store.upsert([
      rec('a', [1, 0, 0], { project_name: 'p', type: 'symbol_body', ref_id: '1' }),
      rec('b', [0, 1, 0], { project_name: 'p', type: 'snapshot', ref_id: '2' }),
      rec('c', [0.95, 0.05, 0], { project_name: 'q', type: 'symbol_body', ref_id: '3' }),
    ]);

    // Nearest to [1,0,0] restricted to project p + symbol_body → only 'a'
    // ('c' is closer in vector space but lives in project q).
    const filtered = await store.search([1, 0, 0], {
      topK: 5,
      filter: { project_name: 'p', type: 'symbol_body' },
    });
    expect(filtered.map((r) => r.id)).toEqual(['a']);
    expect(filtered[0].metadata.ref_id).toBe('1');
    expect(filtered[0].score).toBeGreaterThan(0);

    // No filter → 'a' nearest, 'c' also near.
    const all = await store.search([1, 0, 0], { topK: 3 });
    expect(all[0].id).toBe('a');
    expect(all.map((r) => r.id)).toContain('c');

    // Re-upsert 'a' with a new vector → overwrite, not duplicate.
    await store.upsert([rec('a', [0, 0, 1], { project_name: 'p', type: 'symbol_body', ref_id: '1' })]);
    const moved = await store.search([0, 0, 1], { topK: 1, filter: { project_name: 'p' } });
    expect(moved[0].id).toBe('a');

    await store.deleteByIds(['a']);
    const afterDelete = await store.search([0, 0, 1], { topK: 5, filter: { project_name: 'p' } });
    expect(afterDelete.map((r) => r.id)).not.toContain('a');
  });

  it('is available and returns [] before anything is indexed', async () => {
    const store = new SqliteVecVectorStore({ path: ':memory:' });
    expect(await store.isAvailable()).toBe(true);
    expect(await store.search([1, 2, 3], { topK: 5 })).toEqual([]);
  });

  it('isolates by namespace: a query in one namespace never sees another', async () => {
    const store = new SqliteVecVectorStore({ path: ':memory:' });
    // Same vector space, different namespaces (project A vs project B vs docs).
    await store.upsert([rec('a', [1, 0, 0], { project_name: 'A', type: 'symbol_body', ref_id: '1' })], 'code:A');
    await store.upsert([rec('b', [1, 0, 0], { project_name: 'B', type: 'symbol_body', ref_id: '2' })], 'code:B');
    await store.upsert([rec('d', [1, 0, 0], { type: 'doc_chunk', ref_id: '3' } as Record<string, string>)], 'docs:c5');

    const inA = await store.search([1, 0, 0], { topK: 10, namespace: 'code:A' });
    expect(inA.map((r) => r.id)).toEqual(['a']);

    const inDocs = await store.search([1, 0, 0], { topK: 10, namespace: 'docs:c5' });
    expect(inDocs.map((r) => r.id)).toEqual(['d']);

    // No namespace → sees everything (legacy/aggregate behavior).
    const all = await store.search([1, 0, 0], { topK: 10 });
    expect(all.map((r) => r.id).sort()).toEqual(['a', 'b', 'd']);
  });

  it('deleteNamespace drops only the target namespace', async () => {
    const store = new SqliteVecVectorStore({ path: ':memory:' });
    await store.upsert([rec('a', [1, 0, 0], { project_name: 'A', type: 'file', ref_id: '1' })], 'code:A');
    await store.upsert([rec('b', [0, 1, 0], { project_name: 'B', type: 'file', ref_id: '2' })], 'code:B');

    const removed = await store.deleteNamespace('code:A');
    expect(removed).toBe(1);

    expect((await store.search([1, 0, 0], { topK: 10, namespace: 'code:A' })).length).toBe(0);
    expect((await store.search([0, 1, 0], { topK: 10, namespace: 'code:B' })).map((r) => r.id)).toEqual(['b']);
  });
});
