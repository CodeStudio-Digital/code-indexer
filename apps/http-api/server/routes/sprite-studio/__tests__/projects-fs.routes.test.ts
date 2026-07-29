import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileSessionRepository,
  SessionCatalog,
  SessionLocator,
} from '@mcp/session-storage';
import { OperationalSessionFiles } from '../../../operational-session-files.js';
import type { ServerDeps } from '../../../deps.js';
import { mountSpriteProjectRoutes } from '../projects.routes.js';

const cleanup: string[] = [];

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'sprite-project-fs-route-'));
  cleanup.push(root);
  const dataDir = join(root, 'data');
  const projectRoot = join(root, 'workspace');
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
  ]);
  const project = { id: 31, name: 'Game', root_path: projectRoot };
  const locator = new SessionLocator({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (id) => id === project.id ? project.root_path : null,
      listProjectRoots: () => [{
        project_id: project.id,
        root_path: project.root_path,
      }],
    },
  });
  const repository = new FileSessionRepository({ locator });
  const catalog = new SessionCatalog({ locator, repository });
  const operationalSessionFiles = new OperationalSessionFiles({
    repository,
    catalog,
    locator,
    projects: {
      getProject: (id) => id === project.id ? project : null,
    },
  });
  const app = new Hono();
  mountSpriteProjectRoutes(app, {
    operationalSessionFiles,
    db: {
      getProject: (id: number) => id === project.id ? project : null,
    },
  } as unknown as ServerDeps);
  return { app, projectRoot };
}

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Sprite project filesystem routes', () => {
  it('initializes, reads, updates and recoverably deletes without a sprite SQLite store', async () => {
    const { app, projectRoot } = await harness();
    expect(
      await (await app.request('/api/sprite-studio/projects/31')).json(),
    ).toEqual({ initialized: false, project: null });

    const initialized = await app.request(
      '/api/sprite-studio/projects/31/init',
      { method: 'POST' },
    );
    expect(initialized.status).toBe(200);
    const project = await initialized.json() as { id: string; name: string };
    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(project.name).toBe('Game');
    expect(
      await readFile(
        join(
          projectRoot,
          '.mcp-indexer',
          'session',
          project.id,
          'sprite',
          'project.json',
        ),
        'utf8',
      ),
    ).toContain('"sprite.project"');

    const settings = await app.request(
      '/api/sprite-studio/projects/31/settings',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ width: 64, height: 64, pixelPerfect: true }),
      },
    );
    expect(settings.status).toBe(200);
    expect((await settings.json() as { id: string }).id).toBe(project.id);

    const deleted = await app.request('/api/sprite-studio/projects/31', {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    expect(
      await (await app.request('/api/sprite-studio/projects/31')).json(),
    ).toEqual({ initialized: false, project: null });
  });
});
