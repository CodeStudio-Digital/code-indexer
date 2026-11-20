import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpRouter } from '@mcp/shared/http/router.js';
import { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import { InMemoryRoleEmbeddingStore } from '@mcp/company/role-pipeline/index.js';
import { InMemoryTelemetrySink } from '@mcp/candidate-pipeline';
import { SessionLocator, asCompanySessionId } from '@mcp/session-storage';
import type { ServerDeps } from '../../../deps.js';
import { mountCompanyRecommendationsRoutes } from '../recommendations.js';

const cleanup: string[] = [];

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'company-recommend-routes-'));
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
        template_id: 1,
        config_json: '{}',
      },
    },
  });
  await sessionStore.refresh();
  const files = new CompanySessionFiles({
    companySessionId: asCompanySessionId(company.session.id),
    sessionStore,
  });
  files.createKanbanCardSync({
    title: 'docs typo',
    description: 'fix typo',
    column: 'todo',
    tag: 'documentation',
  });
  files.createKanbanCardSync({
    title: 'production crash',
    description: 'fix prod crash blocking login',
    column: 'todo',
    tag: 'bug',
  });
  files.createKanbanCardSync({
    title: 'refactor auth',
    description: 'X'.repeat(500),
    column: 'todo',
    tag: 'refactor',
  });

  const deps = {
    sessionStore,
    companyStore: {
      getTemplate: () => ({
        roles: [
          {
            role: 'frontend',
            provider: 'anthropic',
            model: 'claude-haiku',
            skills: ['ui'],
          },
          {
            role: 'backend',
            provider: 'anthropic',
            model: 'claude-haiku',
            skills: ['api'],
          },
        ],
      }),
    },
    toolSelectionEmbed: async (text: string) => {
      const vector = new Float32Array(4);
      for (let index = 0; index < vector.length; index += 1) {
        vector[index] = (text.charCodeAt(index) || 0) / 128;
      }
      return vector;
    },
    roleEmbeddingStore: new InMemoryRoleEmbeddingStore(),
    pipelineTelemetrySink: new InMemoryTelemetrySink(),
  } as unknown as ServerDeps;
  const app = new HttpRouter();
  mountCompanyRecommendationsRoutes(app, deps);
  return { app, sessionId: company.session.id };
}

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe('Company filesystem recommendation routes', () => {
  it('prioritizes filesystem cards while keeping opaque UUID ids', async () => {
    const { app, sessionId } = await harness();
    const response = await app.request(
      `/api/company/sessions/${sessionId}/kanban/recompute-priorities`,
      { method: 'POST' },
    );
    expect(response.status).toBe(200);
    const body = await response.json() as {
      ordered: Array<{ id: string; tag: string | null }>;
      diagnostics: Array<{ id: string; score: number }>;
    };
    expect(body.ordered).toHaveLength(3);
    expect(body.diagnostics).toHaveLength(3);
    expect(body.ordered[0]?.tag).toBe('bug');
    expect(body.ordered.every((card) =>
      /^[0-9a-f-]{36}$/.test(card.id),
    )).toBe(true);
  });

  it('returns role recommendations from the reusable template roster', async () => {
    const { app, sessionId } = await harness();
    const response = await app.request(
      `/api/company/sessions/${sessionId}/recommend-role`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'frontend bug fix' }),
      },
    );
    expect(response.status).toBe(200);
    const body = await response.json() as {
      recommendations: Array<{ role: string }>;
    };
    expect(body.recommendations.length).toBeGreaterThan(0);
    expect(
      body.recommendations.some((item) =>
        item.role === 'frontend' || item.role === 'backend',
      ),
    ).toBe(true);
  });

  it('rejects numeric session ids and 404s unknown UUIDs', async () => {
    const { app } = await harness();
    expect((await app.request(
      '/api/company/sessions/42/recommend-role',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'anything' }),
      },
    )).status).toBe(400);
    expect((await app.request(
      `/api/company/sessions/${randomUUID()}/recommend-role`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'anything' }),
      },
    )).status).toBe(404);
  });
});
