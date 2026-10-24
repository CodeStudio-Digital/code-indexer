import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import {
  SessionLocator,
  asCompanySessionId,
} from '@mcp/session-storage';
import type { ServerDeps } from '../../../deps.js';

vi.mock('../stream.js', () => ({
  activeOrchestrators: { get: () => null },
}));

const { mountCompanyKanbanRoutes } = await import('../kanban.js');
const cleanup: string[] = [];

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'company-kanban-routes-'));
  cleanup.push(root);
  const dataDir = join(root, 'data');
  const projectRoot = join(root, 'project');
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
  ]);
  const sessionStore = new FsSessionStore({
    locator: new SessionLocator({
      dataDir,
      projectRootResolver: {
        resolveProjectRoot: (projectId) =>
          projectId === 7 ? projectRoot : null,
        listProjectRoots: () => [{
          project_id: 7,
          root_path: projectRoot,
        }],
      },
    }),
  });
  const company = await sessionStore.repository.createSession({
    kind: 'company',
    scope: { kind: 'project', project_id: 7 },
    owner_project_id: 7,
    linked_projects: [{ project_id: 7, root_path: projectRoot }],
    title: 'Company',
    status: 'idle',
    metadata: {
      company: {
        name: 'Company',
        runtime_kind: 'company',
        config_json: '{}',
      },
    },
  });
  const child = await sessionStore.repository.createSession({
    kind: 'company',
    scope: { kind: 'project', project_id: 7 },
    owner_project_id: 7,
    linked_projects: [{ project_id: 7, root_path: projectRoot }],
    parent_session_id: company.session.id,
    title: 'Child',
    status: 'idle',
    metadata: {
      company: {
        name: 'Child',
        runtime_kind: 'company',
        config_json: '{}',
      },
    },
  });
  await sessionStore.refresh();
  const app = new Hono();
  mountCompanyKanbanRoutes(app, {
    sessionStore,
  } as unknown as ServerDeps);
  return {
    app,
    sessionStore,
    projectRoot,
    rootId: company.session.id,
    childId: child.session.id,
  };
}

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe('Company filesystem Kanban routes', () => {
  it('writes child-session Kanban records to the shared root bundle', async () => {
    const { app, sessionStore, projectRoot, rootId, childId } =
      await harness();
    const response = await app.request(
      `/api/company/sessions/${childId}/kanban`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Filesystem card',
          column: 'todo',
          checklist: ['Persist atomically'],
        }),
      },
    );
    expect(response.status).toBe(201);
    const card = await response.json() as {
      id: string;
      seq: number;
      company_session_id: string;
      checklist: Array<{ id: string }>;
    };
    expect(card.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(card.seq).toBe(1);
    expect(card.company_session_id).toBe(rootId);
    await stat(join(
      projectRoot,
      '.mcp-indexer',
      'session',
      rootId,
      'company',
      'kanban-cards',
      `${card.id}.json`,
    ));
    await expect(stat(join(
      projectRoot,
      '.mcp-indexer',
      'session',
      childId,
      'company',
      'kanban-cards',
      `${card.id}.json`,
    ))).rejects.toMatchObject({ code: 'ENOENT' });

    const rootFiles = new CompanySessionFiles({
      companySessionId: asCompanySessionId(rootId),
      sessionStore,
    });
    expect(rootFiles.getKanbanCardFullSync(card.id)?.title).toBe(
      'Filesystem card',
    );
  });

  it('moves deletion to bundle trash and rejects legacy numeric ids', async () => {
    const { app, projectRoot, rootId } = await harness();
    const created = await app.request(
      `/api/company/sessions/${rootId}/kanban`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Delete me' }),
      },
    );
    const card = await created.json() as { id: string };
    const deleted = await app.request(
      `/api/company/sessions/${rootId}/kanban/${card.id}`,
      { method: 'DELETE' },
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({
      ok: true,
      recoverable: true,
    });
    await stat(join(
      projectRoot,
      '.mcp-indexer',
      'session',
      rootId,
      'company',
      'trash',
      'kanban-cards',
      `${card.id}.json`,
    ));
    expect((await app.request('/api/company/sessions/42/kanban')).status)
      .toBe(400);
  });
});
