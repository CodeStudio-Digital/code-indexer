/**
 * F5/F6 — embedding hash must only commit after vectors verifiably landed,
 * and a run with a failed embedding pipeline must not report plain
 * 'completed'. The retry path then heals everything.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, bigFunctionFixture, type Harness } from './index-agent-harness.js';

describe('embed commit order (multi-window body)', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => h.dispose());

  it('failed upsert → no hash committed, run is completed_with_errors; retry heals', async () => {
    h.writeFile('big.ts', bigFunctionFixture('bigFn'));

    h.vectorStore.failUpserts = true;
    const result = await h.agent.indexProject(h.projectRoot);

    // File analysis succeeded, embedding pipeline failed.
    expect(result.indexedFiles).toBe(1);
    expect(result.errorCount).toBeGreaterThanOrEqual(1);
    const run = h.db.getRun(result.runId);
    expect(run?.status).toBe('completed_with_errors');

    // No vectors landed → no hash may be trusted.
    const sym = h.db.getSymbolsByFile(h.projectId, 'big.ts').find((s) => s.name === 'bigFn');
    expect(sym).toBeDefined();
    const hashes = h.db.raw()
      .prepare('SELECT embedding_hash, body_embedding_hash FROM symbols WHERE id = ?')
      .get(sym!.id) as { embedding_hash: string | null; body_embedding_hash: string | null };
    expect(hashes.body_embedding_hash).toBeNull();
    expect(await h.vectorStore.listIds()).toHaveLength(0);
    expect(h.db.getVectorIdsByProject(h.projectId)).toHaveLength(0);

    // Heal: retry embeddings with a working store.
    h.vectorStore.failUpserts = false;
    const retry = await h.agent.retryEmbeddings(h.projectRoot);
    expect(retry.embedded).toBeGreaterThan(0);

    const healed = h.db.raw()
      .prepare('SELECT body_embedding_hash FROM symbols WHERE id = ?')
      .get(sym!.id) as { body_embedding_hash: string | null };
    expect(healed.body_embedding_hash).not.toBeNull();

    // The big body produced multiple sb_ windows, all present in the store.
    const storeIds = await h.vectorStore.listIds();
    const bodyIds = storeIds.filter((id) => id.startsWith('sb_'));
    expect(bodyIds.length).toBeGreaterThanOrEqual(2);

    // Invariant: every tracked vector id exists in the store and vice versa.
    const tracked = h.db.getVectorIdsByProject(h.projectId).map((v) => v.vector_id).sort();
    expect([...storeIds].sort()).toEqual(tracked);
  });

  it('healthy run commits hashes and reports completed', async () => {
    h.writeFile('big.ts', bigFunctionFixture('bigFn'));
    const result = await h.agent.indexProject(h.projectRoot);
    expect(result.errorCount).toBe(0);
    expect(h.db.getRun(result.runId)?.status).toBe('completed');

    const sym = h.db.getSymbolsByFile(h.projectId, 'big.ts').find((s) => s.name === 'bigFn');
    const hashes = h.db.raw()
      .prepare('SELECT body_embedding_hash FROM symbols WHERE id = ?')
      .get(sym!.id) as { body_embedding_hash: string | null };
    expect(hashes.body_embedding_hash).not.toBeNull();
  });
});
