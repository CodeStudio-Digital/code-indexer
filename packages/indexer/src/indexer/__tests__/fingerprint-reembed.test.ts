/**
 * F12 — an embedding-model change must trigger a FULL re-embed (not just
 * changed files), and the new fingerprint is only stamped after the sweep
 * succeeds, so a failed sweep re-detects the mismatch next run.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, smallFileFixture, bigFunctionFixture, type Harness } from './index-agent-harness.js';

function countNullHashes(h: Harness): { files: number; symbols: number } {
  const f = h.db.raw()
    .prepare('SELECT COUNT(*) AS n FROM files WHERE project_id = ? AND embedding_hash IS NULL')
    .get(h.projectId) as { n: number };
  const s = h.db.raw()
    .prepare("SELECT COUNT(*) AS n FROM symbols WHERE project_id = ? AND kind IN ('function','class','interface','method') AND embedding_hash IS NULL")
    .get(h.projectId) as { n: number };
  return { files: f.n, symbols: s.n };
}

describe('fingerprint change → full re-embed sweep', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness({ fingerprint: 'fake:v1' }); });
  afterEach(() => h.dispose());

  it('re-embeds everything and stamps the new fingerprint only on success', async () => {
    h.writeFile('a.ts', smallFileFixture('alphaFn'));
    h.writeFile('b.ts', bigFunctionFixture('betaFn'));
    await h.agent.indexProject(h.projectRoot);
    expect(h.db.getProjectEmbeddingFingerprint(h.projectId)).toBe('fake:v1');

    // Model switch — NO file changed, so the per-run pass alone would skip everything.
    h.embedding.setFingerprint('fake:v2');
    const result = await h.agent.indexProject(h.projectRoot);
    expect(result.errorCount).toBe(0);

    expect(h.db.getProjectEmbeddingFingerprint(h.projectId)).toBe('fake:v2');
    const nulls = countNullHashes(h);
    expect(nulls.files).toBe(0);
    expect(nulls.symbols).toBe(0);

    // Bidirectional invariant: tracked vector ids === store contents.
    const tracked = h.db.getVectorIdsByProject(h.projectId).map((v) => v.vector_id).sort();
    const stored = (await h.vectorStore.listIds()).sort();
    expect(stored).toEqual(tracked);
    expect(tracked.length).toBeGreaterThan(0);
  });

  it('failed sweep keeps the OLD fingerprint so the next run retries', async () => {
    h.writeFile('a.ts', smallFileFixture('alphaFn'));
    await h.agent.indexProject(h.projectRoot);
    expect(h.db.getProjectEmbeddingFingerprint(h.projectId)).toBe('fake:v1');

    h.embedding.setFingerprint('fake:v3');
    h.vectorStore.failUpserts = true;
    const result = await h.agent.indexProject(h.projectRoot);
    h.vectorStore.failUpserts = false;

    expect(h.db.getRun(result.runId)?.status).toBe('completed_with_errors');
    // Mismatch is preserved — the sweep will re-run next time.
    expect(h.db.getProjectEmbeddingFingerprint(h.projectId)).toBe('fake:v1');

    // Next healthy run completes the sweep.
    const second = await h.agent.indexProject(h.projectRoot);
    expect(second.errorCount).toBe(0);
    expect(h.db.getProjectEmbeddingFingerprint(h.projectId)).toBe('fake:v3');
    const nulls = countNullHashes(h);
    expect(nulls.files).toBe(0);
  });
});
