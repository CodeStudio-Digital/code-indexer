import { mkdtemp, mkdir, rm } from 'node:fs/promises';
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
import { mountCompanyFileSessionRoutes } from '../session-files.routes.js';

const cleanup: string[] = [];

async function appHarness() {
  const root = await mkdtemp(join(tmpdir(), 'company-session-routes-'));
  cleanup.push(root);
  const dataDir = join(root, 'data');
  const projectRoot = join(root, 'project');
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
  ]);
  const project = { id: 7, name: 'Workspace', root_path: projectRoot };
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
  mountCompanyFileSessionRoutes(app, {
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

describe('Company filesystem session routes', () => {
  it('runs create/list/get/rename/delete with opaque UUIDs', async () => {
    const { app } = await appHarness();
    const create = await app.request('/api/company/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Team',
        project_ids: [7],
        master_provider: 'openai',
        master_model: 'gpt-5',
      }),
    });
    expect(create.status, await create.clone().text()).toBe(201);
    const created = await create.json() as {
      session: { id: string; name: string };
    };
    expect(created.session.id).toMatch(/^[0-9a-f-]{36}$/);

    const list = await app.request('/api/company/sessions');
    expect(await list.json()).toEqual([
      expect.objectContaining({ id: created.session.id, name: 'Team' }),
    ]);

    const rename = await app.request(
      `/api/company/sessions/${created.session.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      },
    );
    expect(rename.status).toBe(200);
    expect(await rename.json()).toEqual({
      session: expect.objectContaining({
        id: created.session.id,
        name: 'Renamed',
      }),
    });

    const deleted = await app.request(
      `/api/company/sessions/${created.session.id}`,
      { method: 'DELETE' },
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true, recoverable: true });
    expect(
      (await app.request(`/api/company/sessions/${created.session.id}`)).status,
    ).toBe(404);
  });

  it('rejects numeric legacy IDs at the HTTP boundary', async () => {
    const { app } = await appHarness();
    expect((await app.request('/api/company/sessions/42')).status).toBe(400);
  });
});
