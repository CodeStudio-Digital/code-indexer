import { afterEach, expect, it, vi } from 'vitest';
import { makeStructuralHarness, smallFileFixture } from './structural-test-harness.js';
import { StructuralGeneration } from '../structural-generation.js';

let fixture: ReturnType<typeof makeStructuralHarness> | undefined;
afterEach(() => { fixture?.dispose(); fixture = undefined; });

it('publishes a full reconcile atomically and retains the old generation when a write fails', async () => {
  const h = fixture = makeStructuralHarness();
  h.writeFile('old.ts', smallFileFixture('oldSymbol'));
  await h.indexStructural();
  const revision = h.db.getStructuralRevision(h.projectId);
  h.deleteFile('old.ts');
  h.writeFile('new.ts', smallFileFixture('newSymbol'));
  const original = h.db.upsertFileContent.bind(h.db);
  const failing = vi.spyOn(h.db, 'upsertFileContent').mockImplementation(() => { throw new Error('fixture disk failure'); });
  const result = await h.indexStructural();
  expect(result.errorCount).toBeGreaterThan(0);
  expect(h.db.getFile(h.projectId, 'old.ts')).toBeDefined();
  expect(h.db.getFile(h.projectId, 'new.ts')).toBeUndefined();
  expect(h.db.getStructuralRevision(h.projectId)).toBe(revision);
  failing.mockImplementation(original);
  await h.indexStructural();
  expect(h.db.getFile(h.projectId, 'old.ts')).toBeUndefined();
  expect(h.db.getFile(h.projectId, 'new.ts')).toBeDefined();
  expect(h.db.getStructuralRevision(h.projectId)).not.toBe(revision);
});

it('discards abandoned staging on recovery without deleting active files', async () => {
  const h = fixture = makeStructuralHarness();
  h.writeFile('keep.ts', smallFileFixture('keep'));
  await h.indexStructural();
  const raw = h.db.projectScopedDb(h.projectId);
  raw.prepare('INSERT INTO structural_build_chunks VALUES(?,?,?,?)').run(h.projectId, 'crashed-owner', 1, '{}');
  new StructuralGeneration(h.db, h.projectId).discard();
  expect(raw.prepare('SELECT count(*) AS n FROM structural_build_chunks').get()).toEqual({ n: 0 });
  expect(h.db.getFile(h.projectId, 'keep.ts')).toBeDefined();
});
