/**
 * Deferred structure embeddings: a first index pays ZERO inline embedQuery
 * calls (they used to be 1-2 HTTP round-trips per file) yet still stores the
 * structure embedding (via the batched flush), and the inline similarity
 * gate keeps working on the next structural change.
 * Requires the Node-ABI better-sqlite3 build.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { makeHarness, smallFileFixture, type Harness } from './index-agent-harness.js';

const harnesses: Harness[] = [];
const make = (): Harness => { const h = makeHarness(); harnesses.push(h); return h; };
afterEach(() => { for (const h of harnesses.splice(0)) h.dispose(); });

describe('deferred structure embeddings', () => {
  it('first index: no inline embedQuery, structure embedding stored in batch', async () => {
    const h = make();
    h.writeFile('a.ts', smallFileFixture('alpha'));
    h.writeFile('b.ts', smallFileFixture('beta'));

    const result = await h.agent.indexProject(h.projectRoot);
    expect(result.errorCount).toBe(0);
    expect(h.embedding.queryCalls).toBe(0); // the old flow called embedQuery per file

    const embA = h.db.getFileStructureEmbedding(h.projectId, 'a.ts');
    const embB = h.db.getFileStructureEmbedding(h.projectId, 'b.ts');
    expect(embA).not.toBeNull();
    expect(embB).not.toBeNull();
    expect(embA!.length).toBeGreaterThan(0);
  });

  it('structural change uses the stored embedding for the inline gate', async () => {
    const h = make();
    h.writeFile('a.ts', smallFileFixture('alpha'));
    await h.agent.indexProject(h.projectRoot);
    expect(h.embedding.queryCalls).toBe(0);

    // Change the structure (new exported function) — the gate now HAS an old
    // embedding to compare against, so the inline embedQuery runs.
    h.writeFile('a.ts', `${smallFileFixture('alpha')}\nexport function extra(n: number): number { return n * 2; }\n`);
    const second = await h.agent.indexProject(h.projectRoot);
    expect(second.errorCount).toBe(0);
    expect(second.indexedFiles).toBe(1);
    expect(h.embedding.queryCalls).toBeGreaterThan(0);
  });
});
