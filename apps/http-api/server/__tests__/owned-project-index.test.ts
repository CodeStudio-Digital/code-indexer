import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createOwnedProjectIndex } from '../owned-project-index.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'owned-index-')); roots.push(root);
  await mkdir(join(root, 'foreign'));
  const abort = new AbortController();
  const deps = {
    db: { getProject: vi.fn(() => ({ id: 7, root_path: root })) },
    projectIndexService: { ensureFresh: vi.fn(), reconcileStructural: vi.fn(async (..._args: unknown[]) => ({ status: 'ready' })) },
    semanticCoordinator: { enqueueCodeProjectReindex: vi.fn(() => ({ id: 19 })) },
  };
  const control = { signal: abort.signal, assertCurrent: vi.fn() };
  return { root, abort, deps, control, service: createOwnedProjectIndex(deps as never) };
}
it('indexes only the owner project and starts semantic work after readiness', async () => {
  const f = await fixture();
  const result = await f.service.reconcile(7, { project_path: f.root, rebuild_semantic: true }, f.control);
  expect(result).toContain('rebuild job #19');
  expect(f.deps.projectIndexService.ensureFresh).not.toHaveBeenCalled();
  expect(f.deps.projectIndexService.reconcileStructural).toHaveBeenCalledWith(7, 180000, f.abort.signal, expect.any(Function));
  expect(f.deps.semanticCoordinator.enqueueCodeProjectReindex).toHaveBeenCalledWith(7, true);
});
it('rejects foreign paths and malformed inputs before scheduling any effect', async () => {
  const f = await fixture();
  for (const input of [{ project_path: join(f.root, 'foreign') }, { project_path: f.root, rebuild_semantic: 'yes' }, { project_path: '' }]) {
    await expect(f.service.reconcile(7, input, f.control)).rejects.toThrow();
  }
  expect(f.deps.projectIndexService.ensureFresh).not.toHaveBeenCalled();
  expect(f.deps.semanticCoordinator.enqueueCodeProjectReindex).not.toHaveBeenCalled();
});
it.each(['cancel', 'lease'] as const)('fences semantic dispatch after %s while waiting for structural readiness', async cause => {
  const f = await fixture();
  f.deps.projectIndexService.reconcileStructural.mockImplementationOnce(async () => {
    if (cause === 'cancel') f.abort.abort(new Error('stopped'));
    else f.control.assertCurrent.mockImplementation(() => { throw new Error('lease lost'); });
    return { status: 'ready' };
  });
  await expect(f.service.reconcile(7, { project_path: f.root }, f.control)).rejects.toThrow(/stopped|lease lost/);
  expect(f.deps.semanticCoordinator.enqueueCodeProjectReindex).not.toHaveBeenCalled();
});
it('reports unfinished structural work without issuing semantic work', async () => {
  const f = await fixture(); f.deps.projectIndexService.reconcileStructural.mockResolvedValueOnce({ status: 'indexing' });
  expect(await f.service.reconcile(7, { project_path: f.root }, f.control)).toContain('semantic indexing was not requested');
  expect(f.deps.semanticCoordinator.enqueueCodeProjectReindex).not.toHaveBeenCalled();
});
