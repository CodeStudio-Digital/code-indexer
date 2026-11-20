/**
 * A store instance that scanned before another instance created a session
 * (a worker's store, and the app creating child agents) does not see it
 * until it rescans. discoverNewSessions adds the new bundles without a full
 * rescan, and leaves the known ones alone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsSessionStore } from '../index.js';

let root: string;
let stores: FsSessionStore[];
const open = () => {
  const store = FsSessionStore.fromRoots({ dataDir: join(root, 'data'), projectRootResolver: {
    resolveProjectRoot: (id) => (id === 1 ? join(root, 'p1') : undefined),
    listProjectRoots: () => [{ project_id: 1, root_path: join(root, 'p1') }] } });
  stores.push(store);
  return store;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'discover-new-sessions-'));
  for (const path of ['data/sessions/global', 'p1']) await mkdir(join(root, path), { recursive: true });
  stores = [];
});
afterEach(async () => {
  await Promise.all(stores.map((store) => store.close()));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('discoverNewSessions', () => {
  it('finds sessions another instance created after this one scanned, without rereading known ones', async () => {
    const app = open();
    const parent = (await app.createSession({ project_id: 1, title: 'Parent', provider: 'p', model: 'm', agent: 'build' })).id;
    const worker = open();
    expect((await worker.getSession(parent))?.title).toBe('Parent'); // scanned now
    const later = (await app.createSession({ project_id: 1, title: 'Later', provider: 'p', model: 'm', agent: 'build' })).id;
    expect(await worker.getSession(later)).toBeNull();
    expect(await worker.listChildAgentSessions(parent)).toEqual([]);
    expect(await worker.discoverNewSessions()).toBe(1);
    expect((await worker.getSession(later))?.title).toBe('Later');
    expect(await worker.discoverNewSessions()).toBe(0);
  });

  it('is a first scan when the catalog was never read', async () => {
    const app = open();
    await app.createSession({ project_id: 1, title: 'One', provider: 'p', model: 'm', agent: 'build' });
    expect(await open().discoverNewSessions()).toBe(1);
  });
});
