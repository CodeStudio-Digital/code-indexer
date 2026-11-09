import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSessionRepository, SessionLocator, SessionLeaseHeldError } from '../index.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(kind: 'company' | 'app_studio' | 'coder' = 'company') {
  const directory = await mkdtemp(join(tmpdir(), 'company-writer-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const dataDir = join(directory, 'data'); await mkdir(dataDir);
  const locator = new SessionLocator({ dataDir, projectRootResolver: { resolveProjectRoot: () => null, listProjectRoots: () => [] } });
  const main = new FileSessionRepository({ locator, writerOwnerId: 'main-fixture' });
  const worker = new FileSessionRepository({ locator, writerOwnerId: 'worker-fixture' });
  cleanup.push(() => main.close(), () => worker.close());
  const { location } = await main.createSession({ kind, scope: { kind: 'global' } });
  return { main, worker, location };
}

describe('Company metadata writer lifetime', () => {
  it.each(['company', 'app_studio'] as const)('allows configuration, worker startup and later HTTP edits for %s', async kind => {
    const { main, worker, location } = await fixture(kind);
    await main.updateSession(location, s => ({ ...s, metadata: { ...s.metadata, reasoning: 'max' } }));
    await worker.updateState(location, s => ({ ...s, status: 'running' }));
    await main.updateSession(location, s => ({ ...s, title: 'Renamed while running' }));
    await worker.updateState(location, s => ({ ...s, status: 'idle' }));
    expect(main.readSessionSync(location)).toMatchObject({ title: 'Renamed while running', metadata: { reasoning: 'max' } });
    expect(main.readStateSync(location).status).toBe('idle');
    await expect(readFile(join(location.bundle_path, 'events/writer.lease'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes competing repositories without dropping increments or holding idle leases', async () => {
    const { main, worker, location } = await fixture();
    await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? main : worker).updateSession(location, s => ({
      ...s, metadata: { ...s.metadata, count: Number(s.metadata.count ?? 0) + 1 },
    }))));
    expect(main.readSessionSync(location).metadata.count).toBe(12);
    await expect(readFile(join(location.bundle_path, 'events/writer.lease'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('waits for an existing owner to release without stealing its lease', async () => {
    const { main, worker, location } = await fixture();
    await main.primeSession(location);
    const update = vi.fn(s => ({ ...s, status: 'running' }));
    const pending = worker.updateState(location, update);
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(update).not.toHaveBeenCalled();
    await main.closeSession(location);
    await pending;
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('releases after a failed callback and never replays a mutation', async () => {
    const { main, worker, location } = await fixture();
    const update = vi.fn(() => { throw new SessionLeaseHeldError('inside mutation'); });
    await expect(main.updateState(location, update)).rejects.toThrow('inside mutation');
    expect(update).toHaveBeenCalledTimes(1);
    await worker.updateState(location, s => ({ ...s, status: 'idle' }));
  });

  it('preserves exclusive ownership of coder journals until explicit handoff', async () => {
    const { main, worker, location } = await fixture('coder');
    await main.updateState(location, s => ({ ...s, status: 'running' }));
    await expect(worker.updateState(location, s => ({ ...s, status: 'idle' }))).rejects.toBeInstanceOf(SessionLeaseHeldError);
    await main.closeSession(location);
    await worker.updateState(location, s => ({ ...s, status: 'idle' }));
  });
});
