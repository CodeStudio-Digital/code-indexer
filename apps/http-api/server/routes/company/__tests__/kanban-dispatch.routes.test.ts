import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import { InMemoryRoleEmbeddingStore } from '@mcp/company/role-pipeline/index.js';
import { InMemoryTelemetrySink } from '@mcp/candidate-pipeline';
import {
  SessionLocator,
  asCompanySessionId,
  asSessionId,
} from '@mcp/session-storage';
import type { ServerDeps } from '../../../deps.js';

const dispatchCardMock = vi.fn();
vi.mock('../../../../sse/companyOrchestrator.js', () => ({
  getOrSpawnCompanyOrchestrator: vi.fn(async () => ({
    orchestrator: { dispatchCard: dispatchCardMock },
    bus: {},
  })),
  evictCompanyOrchestrator: vi.fn(async () => undefined),
}));

const { mountCompanyKanbanDispatchRoutes } =
  await import('../kanban-dispatch.js');

const cleanup: string[] = [];

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'company-kanban-dispatch-'));
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
  const readyTodo = files.createKanbanCardSync({
    title: 'build login form',
    description: 'frontend',
    column: 'todo',
  });
  const readyBacklog = files.createKanbanCardSync({
    title: 'write api docs',
    description: 'docs',
    column: 'backlog',
  });
  const blocker = files.createKanbanCardSync({
    title: 'setup database',
    column: 'todo',
  });
  const blocked = files.createKanbanCardSync({
    title: 'wire auth to db',
    column: 'todo',
  });
  files.addKanbanDependencySync(blocked.id, blocker.id);
  const assigned = files.createKanbanCardSync({
    title: 'already worked',
    column: 'todo',
  });
  files.assignKanbanAgentSync(assigned.id, randomUUID(), 'backend');

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
  const app = new Hono();
  mountCompanyKanbanDispatchRoutes(app, deps);
  return {
    app,
    sessionId: company.session.id,
    cards: { readyTodo, readyBacklog, blocked, assigned },
  };
}

afterEach(async () => {
  dispatchCardMock.mockReset();
  await Promise.all(
    cleanup.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe('Company filesystem Kanban dispatch routes', () => {
  it('suggests roles only for ready UUID cards', async () => {
    const { app, sessionId, cards } = await harness();
    const response = await app.request(
      `/api/company/sessions/${sessionId}/kanban/suggest-roles`,
      { method: 'POST' },
    );
    expect(response.status).toBe(200);
    const body = await response.json() as {
      suggestions: Array<{ cardId: string; role: string }>;
    };
    const ids = body.suggestions.map((suggestion) => suggestion.cardId);
    expect(ids).toContain(cards.readyTodo.id);
    expect(ids).toContain(cards.readyBacklog.id);
    expect(ids).not.toContain(cards.blocked.id);
    expect(ids).not.toContain(cards.assigned.id);
    expect(body.suggestions.every((item) =>
      /^[0-9a-f-]{36}$/.test(item.cardId) && item.role.length > 0,
    )).toBe(true);
  });

  it('dispatches an opaque card id and returns an opaque agent-run id', async () => {
    const { app, sessionId, cards } = await harness();
    const agentRunId = randomUUID();
    dispatchCardMock.mockResolvedValue({
      ok: true,
      cardId: cards.readyTodo.id,
      role: 'frontend',
      agentRunId,
    });
    const response = await app.request(
      `/api/company/sessions/${sessionId}/kanban/cards/${cards.readyTodo.id}/dispatch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'frontend' }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      agentRunId,
      role: 'frontend',
    });
    expect(dispatchCardMock).toHaveBeenCalledWith(
      cards.readyTodo.id,
      'frontend',
    );
  });

  it('rejects legacy numeric ids and 404s a well-formed unknown UUID', async () => {
    const { app } = await harness();
    expect((await app.request(
      '/api/company/sessions/42/kanban/suggest-roles',
      { method: 'POST' },
    )).status).toBe(400);
    expect((await app.request(
      `/api/company/sessions/${asSessionId(randomUUID())}/kanban/suggest-roles`,
      { method: 'POST' },
    )).status).toBe(404);
  });
});
