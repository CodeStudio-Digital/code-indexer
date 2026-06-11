/**
 * F7 — deleting a file removes its vectors everywhere; a failing remote
 * delete tombstones into pending_vector_deletes instead of orphaning.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, smallFileFixture, bigFunctionFixture, type Harness } from './index-agent-harness.js';

describe('incremental consistency on file deletion', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => h.dispose());

  it('deleted file → vector_ids rows gone and store ids gone', async () => {
    h.writeFile('keep.ts', smallFileFixture('keepFn'));
    h.writeFile('gone.ts', bigFunctionFixture('goneFn'));
    await h.agent.indexProject(h.projectRoot);

    const before = h.db.getVectorIdsByProject(h.projectId);
    const goneIds = before.filter((v) => v.file_path === 'gone.ts').map((v) => v.vector_id);
    expect(goneIds.length).toBeGreaterThan(0);

    h.deleteFile('gone.ts');
    const result = await h.agent.indexProject(h.projectRoot);
    expect(result.errorCount).toBe(0);

    const after = h.db.getVectorIdsByProject(h.projectId);
    expect(after.filter((v) => v.file_path === 'gone.ts')).toHaveLength(0);
    const storeIds = await h.vectorStore.listIds();
    for (const id of goneIds) expect(storeIds).not.toContain(id);
    // The file row itself is gone too.
    expect(h.db.getFile(h.projectId, 'gone.ts')).toBeUndefined();
  });

  it('failing remote delete → ids land in the tombstone queue', async () => {
    h.writeFile('keep.ts', smallFileFixture('keepFn'));
    h.writeFile('flaky.ts', bigFunctionFixture('flakyFn'));
    await h.agent.indexProject(h.projectRoot);

    const flakyIds = h.db.getVectorIdsByProject(h.projectId)
      .filter((v) => v.file_path === 'flaky.ts')
      .map((v) => v.vector_id);
    expect(flakyIds.length).toBeGreaterThan(0);

    h.deleteFile('flaky.ts');
    h.vectorStore.failDeletes = true;
    const result = await h.agent.indexProject(h.projectRoot);
    h.vectorStore.failDeletes = false;

    // The run itself survives (delete failures are tombstoned, not fatal).
    expect(['completed', 'completed_with_errors']).toContain(h.db.getRun(result.runId)?.status);

    // Local rows are gone; remote retries wait in the queue.
    expect(h.db.getVectorIdsByProject(h.projectId).filter((v) => v.file_path === 'flaky.ts')).toHaveLength(0);
    const pending = h.db.takePendingVectorDeletes().map((p) => p.vector_id);
    for (const id of flakyIds) expect(pending).toContain(id);
  });
});
