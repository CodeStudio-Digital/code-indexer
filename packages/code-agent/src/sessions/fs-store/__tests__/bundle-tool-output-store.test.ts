import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { BundleToolOutputStore, FsSessionStore } from '../index.js';

describe('BundleToolOutputStore', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function createStore() {
    const root = await mkdtemp(join(tmpdir(), 'bundle-output-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const projectRoot = join(root, 'project');
    await mkdir(dataDir);
    await mkdir(projectRoot);
    const options = {
      dataDir,
      projectRootResolver: {
        resolveProjectRoot: (id: number) => (id === 7 ? projectRoot : null),
        listProjectRoots: () => [
          { project_id: 7, root_path: projectRoot },
        ],
      },
      projectInfoResolver: (id: number) =>
        id === 7
          ? { project_id: 7, name: 'Project', root_path: projectRoot }
          : null,
    };
    const store = FsSessionStore.fromRoots(options);
    const session = await store.createSession({
      project_id: 7,
      title: 'outputs',
      provider: 'test',
      model: 'test',
    });
    return { options, store, session };
  }

  it('keeps full outputs in the session bundle across restart', async () => {
    const { options, store, session } = await createStore();
    const outputs = new BundleToolOutputStore(store, session.id);
    const id = outputs.put('full output that must never expire');

    expect(id).toMatch(/^[a-f0-9]{24}$/);
    expect(outputs.get(id!)).toBe('full output that must never expire');
    await outputs.drain();
    await store.close();

    const reopened = FsSessionStore.fromRoots(options);
    await reopened.refresh();
    const recovered = new BundleToolOutputStore(reopened, session.id);
    expect(recovered.hasOutputs()).toBe(true);
    expect(recovered.get(id!)).toBe('full output that must never expire');
    await reopened.close();
  });

  it('rejects non-hex recovery handles', async () => {
    const { store, session } = await createStore();
    const outputs = new BundleToolOutputStore(store, session.id);
    expect(outputs.get('../escape')).toBeNull();
    await store.close();
  });
});
