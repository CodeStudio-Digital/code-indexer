import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpRouter } from '@mcp/shared/http/router.js';
import { afterEach, describe, expect, it } from 'vitest';
import { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import { SessionLocator, asCompanySessionId } from '@mcp/session-storage';
import type { ServerDeps } from '../../../deps.js';
import { mountCompanyBoardRoutes } from '../board.js';

const cleanup: string[] = [];

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'company-board-routes-'));
  cleanup.push(root);
  const dataDir = join(root, 'data');
  const projectRoot = join(root, 'project');
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
  ]);
  const locator = new SessionLocator({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) =>
        projectId === 7 ? projectRoot : null,
      listProjectRoots: () => [{
        project_id: 7,
        root_path: projectRoot,
      }],
    },
  });
  const sessionStore = new FsSessionStore({ locator });
  const company = await sessionStore.repository.createSession({
    kind: 'company',
    scope: { kind: 'project', project_id: 7 },
    owner_project_id: 7,
    linked_projects: [{ project_id: 7, root_path: projectRoot }],
    title: 'Company',
    status: 'idle',
    metadata: { company: { runtime_kind: 'company' } },
  });
  await sessionStore.refresh();
  const files = new CompanySessionFiles({
    companySessionId: asCompanySessionId(company.session.id),
    sessionStore,
  });
  const first = files.createBoardEntry({
    authorRole: 'system',
    agentRunId: null,
    kind: 'message',
    content: 'first',
  });
  const second = files.createBoardEntry({
    authorRole: 'human',
    agentRunId: null,
    kind: 'decision',
    content: 'second',
  });
  const app = new HttpRouter();
  mountCompanyBoardRoutes(app, {
    sessionStore,
  } as unknown as ServerDeps);
  return { app, sessionId: company.session.id, first, second };
}

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe('Company filesystem board routes', () => {
  it('paginates by seq while returning opaque item UUIDs', async () => {
    const { app, sessionId, first, second } = await harness();
    const response = await app.request(
      `/api/company/sessions/${sessionId}/board?since_seq=${first.seq}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      expect.objectContaining({
        id: second.id,
        seq: second.seq,
        company_session_id: sessionId,
        content: 'second',
      }),
    ]);
  });

  it('rejects numeric legacy session IDs', async () => {
    const { app } = await harness();
    expect((await app.request('/api/company/sessions/42/board')).status).toBe(
      400,
    );
  });
});
