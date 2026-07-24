import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { CompanyStore } from '@mcp/store/company-store.js';
import type { PipelineGraph } from '@mcp/company/types.js';
import type { ServerDeps } from '../../../deps.js';

const H = vi.hoisted(() => ({
  getOrSpawn: vi.fn(),
  getActive: vi.fn(),
  deleteActive: vi.fn(),
}));

vi.mock('../../../../sse/companyOrchestrator.js', () => ({
  getOrSpawnCompanyOrchestrator: H.getOrSpawn,
  getCompanyOrchestrator: H.getActive,
  hasCompanyOrchestrator: vi.fn(() => false),
  deleteCompanyOrchestrator: H.deleteActive,
  evictCompanyOrchestrator: vi.fn(async (id: number) => {
    H.deleteActive(id);
  }),
}));
vi.mock('@mcp/api-handlers', () => ({
  generateAiPipeline: vi.fn(),
}));
const { mountCompanyKanbanRoutes } = await import('../kanban.js');
const { mountCompanyKanbanDispatchRoutes } = await import('../kanban-dispatch.js');
const { mountCompanyPipelineRoutes } = await import('../pipelines.js');
const { mountCompanyAgentControlRoutes } = await import('../agents.js');
const { mountCompanyArchiveRoutes } = await import('../archives.js');
const { mountReestablishMasterRoute } = await import('../reestablish-master.js');
const { mountCompanySessionRoutes } = await import('../sessions.js');
const { mountCompanyStreamRoutes } = await import('../stream.js');
const { mountCompanyInboxRoutes } = await import('../inbox.js');
const { mountCompanyEnvsRoutes } = await import('../envs.js');

const graph: PipelineGraph = {
  version: 1,
  nodes: [{
    id: 'implement',
    label: 'Implement',
    role: 'backend',
    taskTemplate: '{{initial_input}}',
  }],
  edges: [],
};

interface Handle {
  app: Hono;
  db: CodeIndexDB;
  companyStore: CompanyStore;
  genericId: number;
  appId: number;
  dir: string;
}

function setup(): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-company-cap-routes-'));
  const dbPath = join(dir, 'test.db');
  const db = new CodeIndexDB(dbPath);
  const companyStore = new CompanyStore(dbPath);
  const generic = companyStore.createCompanySession({ name: 'Company', config_json: '{}' });
  const appTeam = companyStore.createCompanySession({
    name: 'App team',
    config_json: '{}',
    runtime_kind: 'app_studio',
  });

  const app = new Hono();
  const deps = {
    companyStore,
    db,
    appStudioStore: { getSessionByCompanySessionId: vi.fn(() => null) },
    companySessionEnvStore: {
      list: vi.fn(() => []),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
  } as unknown as ServerDeps;
  mountCompanyKanbanRoutes(app, deps);
  mountCompanyKanbanDispatchRoutes(app, deps);
  mountCompanyPipelineRoutes(app, deps);
  mountCompanyAgentControlRoutes(app, deps);
  mountCompanyArchiveRoutes(app, deps);
  mountReestablishMasterRoute(app, deps);
  mountCompanySessionRoutes(app, deps);
  mountCompanyStreamRoutes(app, deps);
  mountCompanyInboxRoutes(app, deps);
  mountCompanyEnvsRoutes(app, deps);
  return { app, db, companyStore, genericId: generic.id, appId: appTeam.id, dir };
}

function teardown(h: Handle): void {
  try { h.companyStore.close(); } catch { /* already closed */ }
  try { h.db.close(); } catch { /* already closed */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* Windows handle lag */ }
}

describe('Company route capability boundary for App Studio teams', () => {
  let h: Handle;

  beforeEach(() => {
    H.getOrSpawn.mockReset();
    H.getActive.mockReset();
    H.deleteActive.mockReset();
    h = setup();
  });
  afterEach(() => teardown(h));

  it('preserves generic Company Kanban CRUD', async () => {
    const created = await h.app.request(`/api/company/sessions/${h.genericId}/kanban`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Generic card' }),
    });
    expect(created.status).toBe(201);

    const listed = await h.app.request(`/api/company/sessions/${h.genericId}/kanban`);
    expect(listed.status).toBe(200);
    expect((await listed.json()) as unknown[]).toHaveLength(1);
  });

  it('returns an empty App Kanban projection and rejects mutations before storage', async () => {
    const listed = await h.app.request(`/api/company/sessions/${h.appId}/kanban`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([]);

    const created = await h.app.request(`/api/company/sessions/${h.appId}/kanban`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Must not exist' }),
    });
    expect(created.status).toBe(409);
    expect(await created.json()).toMatchObject({
      code: 'COMPANY_SURFACE_UNAVAILABLE_FOR_APP',
      surface: 'kanban',
    });
    expect(h.companyStore.listKanbanCardsFull(h.appId)).toEqual([]);
  });

  it('rejects App manual dispatch without spawning a Company orchestrator', async () => {
    const response = await h.app.request(
      `/api/company/sessions/${h.appId}/kanban/cards/1/dispatch`,
      { method: 'POST' },
    );
    expect(response.status).toBe(409);
    expect(H.getOrSpawn).not.toHaveBeenCalled();

    const suggestions = await h.app.request(
      `/api/company/sessions/${h.appId}/kanban/suggest-roles`,
      { method: 'POST' },
    );
    expect(suggestions.status).toBe(200);
    expect(await suggestions.json()).toEqual({ suggestions: [] });
  });

  it('preserves generic pipeline definitions but blocks App-owned definitions', async () => {
    const generic = await h.app.request('/api/company/pipelines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Generic pipeline', graph, company_session_id: h.genericId }),
    });
    expect(generic.status).toBe(201);

    const blocked = await h.app.request('/api/company/pipelines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'App pipeline', graph, company_session_id: h.appId }),
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      code: 'COMPANY_SURFACE_UNAVAILABLE_FOR_APP',
      surface: 'pipelines',
    });
    expect(h.companyStore.listPipelines({ companySessionId: h.appId })).toEqual([]);
  });

  it('preserves the full generic Company role runtime contract', async () => {
    const response = await h.app.request(`/api/company/sessions/${h.genericId}/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role_assignments: [{
          role: 'backend',
          enabled: false,
          provider: 'openai-chatgpt',
          model: 'gpt-5.6-sol',
          tier: 'full',
          thinking: true,
          thinkingBudgetTokens: 2048,
          reasoningEffort: 'high',
          fallbackModels: [{ provider: 'openai-chatgpt', model: 'gpt-5.6-terra' }],
        }],
      }),
    });
    expect(response.status).toBe(200);
    const persisted = JSON.parse(h.companyStore.getCompanySession(h.genericId)!.config_json) as {
      role_assignments: unknown[];
    };
    expect(persisted.role_assignments).toEqual([expect.objectContaining({
      role: 'backend',
      enabled: false,
      provider: 'openai-chatgpt',
      model: 'gpt-5.6-sol',
      tier: 'full',
      thinking: true,
      thinkingBudgetTokens: 2048,
      reasoningEffort: 'high',
      fallbackModels: [{ provider: 'openai-chatgpt', model: 'gpt-5.6-terra' }],
    })]);
  });

  it('returns empty App pipeline reads and rejects start before the orchestrator', async () => {
    const pipeline = h.companyStore.createPipeline({
      name: 'Legacy App pipeline',
      graph,
      companySessionId: h.appId,
    });

    const listed = await h.app.request(`/api/company/pipelines?company_session_id=${h.appId}`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([]);

    const executions = await h.app.request(
      `/api/company/sessions/${h.appId}/pipelines/executions`,
    );
    expect(executions.status).toBe(200);
    expect(await executions.json()).toEqual([]);

    const started = await h.app.request(
      `/api/company/sessions/${h.appId}/pipelines/${pipeline.id}/start`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ initial_input: 'go' }),
      },
    );
    expect(started.status).toBe(409);
    expect(H.getActive).not.toHaveBeenCalled();
  });

  it('rejects every generic Company control-plane mutation for an App-owned team', async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [
      { method: 'POST', path: `/api/company/sessions/${h.appId}/abort` },
      {
        method: 'POST',
        path: `/api/company/sessions/${h.appId}/switch`,
        body: { provider: 'openai-chatgpt', model: 'gpt-5.4-mini' },
      },
      {
        method: 'POST',
        path: `/api/company/sessions/${h.appId}/reestablish-master`,
        body: { provider: 'openai-chatgpt', model: 'gpt-5.4-mini' },
      },
      {
        method: 'PATCH',
        path: `/api/company/sessions/${h.appId}/config`,
        body: { role_assignments: [] },
      },
      { method: 'POST', path: `/api/company/sessions/${h.appId}/agents/999/pause` },
      { method: 'POST', path: `/api/company/sessions/${h.appId}/agents/999/resume`, body: {} },
      { method: 'DELETE', path: `/api/company/sessions/${h.appId}/agents/999` },
      { method: 'POST', path: `/api/company/sessions/${h.appId}/reset`, body: {} },
      { method: 'POST', path: `/api/company/sessions/${h.appId}/inbox/999/cancel`, body: {} },
      { method: 'POST', path: `/api/company/sessions/${h.appId}/inbox/999/respond`, body: { answer: 'no' } },
      { method: 'PUT', path: `/api/company/sessions/${h.appId}/envs/API_KEY`, body: { value: 'secret' } },
      { method: 'DELETE', path: `/api/company/sessions/${h.appId}/envs/API_KEY` },
      { method: 'GET', path: `/api/company/sessions/${h.appId}/envs?reveal=1` },
    ];

    for (const request of requests) {
      const response = await h.app.request(request.path, {
        method: request.method,
        headers: request.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
      expect(response.status, `${request.method} ${request.path}`).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'APP_STUDIO_CONTROL_PLANE_OWNED',
        runtime_kind: 'app_studio',
      });
    }

    expect(H.getOrSpawn).not.toHaveBeenCalled();
    expect(H.getActive).not.toHaveBeenCalled();
    expect(H.deleteActive).not.toHaveBeenCalled();
  });
});
