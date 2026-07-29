import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/index.js';
import { mountSessionTrashRoutes } from '../session-trash.js';

let root: string;
let dataDir: string;
let projectRoot: string;
let store: FsSessionStore;
let app: Hono;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcp-session-trash-route-'));
  dataDir = join(root, 'data');
  projectRoot = join(root, 'project');
  await Promise.all([mkdir(dataDir), mkdir(projectRoot)]);
  store = FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (id) => id === 7 ? projectRoot : null,
      listProjectRoots: () => [{ project_id: 7, root_path: projectRoot }],
    },
  });
  app = new Hono();
  mountSessionTrashRoutes(app, { sessionStore: store });
});

afterEach(async () => {
  await store.close();
  await rm(root, { recursive: true, force: true });
});

describe('generic filesystem session trash routes', () => {
  it('lists and restores a project-scoped coder bundle with metadata.kind', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Recover me',
      provider: 'test',
      model: 'model',
    });
    const trashed = await store.deleteSession(session.id);

    const listed = await app.request('/api/sessions/trash?scope=project&project_id=7');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      scope: { kind: 'project', project_id: 7 },
      items: [{
        trash_name: trashed.trash_name,
        trashed_at: trashed.trashed_at,
        metadata: {
          id: session.id,
          kind: 'coder',
          title: 'Recover me',
        },
      }],
    });

    const restored = await app.request(
      `/api/sessions/trash/${trashed.trash_name}/restore?scope=project&project_id=7`,
      { method: 'POST' },
    );
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({
      ok: true,
      trash_name: trashed.trash_name,
      scope: { kind: 'project', project_id: 7 },
      metadata: { id: session.id, kind: 'coder' },
    });
    await expect(store.getSession(session.id)).resolves.toMatchObject({ id: session.id });
  });

  it('lists and permanently purges a global bundle of any session kind', async () => {
    const created = await store.repository.createSession({
      kind: 'company',
      scope: { kind: 'global' },
      title: 'Global company',
    });
    const trashed = await store.repository.trashSession(created.location);

    const listed = await app.request('/api/sessions/trash?scope=global');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      scope: { kind: 'global' },
      items: [{
        trash_name: trashed.trash_name,
        metadata: {
          id: created.session.id,
          kind: 'company',
          title: 'Global company',
        },
      }],
    });

    const purged = await app.request(
      `/api/sessions/trash/${trashed.trash_name}/purge?scope=global`,
      { method: 'POST' },
    );
    expect(purged.status).toBe(200);
    expect(await purged.json()).toMatchObject({
      ok: true,
      trash_name: trashed.trash_name,
      metadata: { id: created.session.id, kind: 'company' },
    });
    expect(await (await app.request('/api/sessions/trash?scope=global')).json())
      .toMatchObject({ items: [] });
  });

  it('requires an exact scope and rejects traversal or invented trash names', async () => {
    expect((await app.request('/api/sessions/trash')).status).toBe(400);
    expect((await app.request(
      '/api/sessions/trash?scope=global&project_id=7',
    )).status).toBe(400);
    expect((await app.request(
      '/api/sessions/trash?scope=project&project_id=7.1',
    )).status).toBe(400);

    const invented = await app.request(
      '/api/sessions/trash/safe-but-not-a-trash-token/restore?scope=global',
      { method: 'POST' },
    );
    expect(invented.status).toBe(400);

    const traversal = await app.request(
      '/api/sessions/trash/%2E%2E%5Coutside/purge?scope=global',
      { method: 'POST' },
    );
    expect([400, 404]).toContain(traversal.status);
  });
});
