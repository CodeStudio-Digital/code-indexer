/**
 * Integration tests for the C3 proactive-kanban routes:
 *   POST /api/company/sessions/:id/kanban/suggest-roles   (read-only, real DB)
 *   POST /api/company/sessions/:id/kanban/cards/:cardId/dispatch
 *     (orchestrator mocked — the worker pool is out of scope here; the
 *      dispatch unit itself is covered by dispatch-card.test.ts)
 *
 * Follows the recommendations.routes.test.ts pattern: real CodeIndexDB +
 * CompanyStore with seeded cards, minimal ServerDeps subset.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { CompanyStore } from '@mcp/store/company-store.js';
import { InMemoryRoleEmbeddingStore } from '@mcp/company/role-pipeline/index.js';
import { InMemoryTelemetrySink } from '@mcp/candidate-pipeline';
import type { ServerDeps } from '../../../deps.js';

const dispatchCardMock = vi.fn();
vi.mock('../../../../sse/companyOrchestrator.js', () => ({
  getOrSpawnCompanyOrchestrator: vi.fn(async () => ({
    orchestrator: { dispatchCard: dispatchCardMock },
    bus: {},
  })),
}));

// Import AFTER the mock so the route picks up the stubbed module.
const { mountCompanyKanbanDispatchRoutes } = await import('../kanban-dispatch.js');

interface Handle {
  app: Hono;
  db: CodeIndexDB;
  companyStore: CompanyStore;
  sessionId: number;
  dir: string;
  cardIds: { ready1: number; ready2: number; blocked: number; assigned: number };
}

function setup(): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-kdispatch-routes-'));
  const dbPath = join(dir, 'test.db');
  const db = new CodeIndexDB(dbPath);
  const companyStore = new CompanyStore(dbPath);

  const template = companyStore.createTemplate('test', 'test description', [
    { role: 'frontend', provider: 'anthropic', model: 'claude-haiku', tier: 'navigate' },
    { role: 'backend',  provider: 'anthropic', model: 'claude-haiku', tier: 'navigate' },
  ]);
  const session = companyStore.createCompanySession({
    template_id: template.id,
    name: 'test-session',
    config_json: '{}',
  });
  const mk = (title: string, column: 'todo' | 'backlog') =>
    companyStore.createKanbanCard(session.id, {
      title, description: `${title} details`, column, created_by: 'human',
    });
  const ready1 = mk('build login form', 'todo');
  const ready2 = mk('write api docs', 'backlog');
  const blocker = mk('setup database', 'todo');
  const blocked = mk('wire auth to db', 'todo');
  companyStore.addCardDependency(blocked.id, blocker.id);
  const assigned = mk('already worked', 'todo');
  // company_agent_runs FKs coder_sessions(id) → projects(id): seed the chain.
  const project = db.createProject('test-project', join(dir, 'proj'));
  db.raw()
    .prepare(`INSERT INTO coder_sessions (project_id, title, provider, model) VALUES (?, 't', 'p', 'm')`)
    .run(project.id);
  const coderSessionId = (db.raw().prepare('SELECT id FROM coder_sessions').get() as { id: number }).id;
  const run = companyStore.createAgentRun({
    company_session_id: session.id,
    role: 'backend',
    coder_session_id: coderSessionId,
    project_ids: [project.id],
    provider: 'anthropic',
    model: 'claude-haiku',
  });
  companyStore.assignAgentToCard(assigned.id, run.id, 'backend');

  const app = new Hono();
  const deps = {
    companyStore,
    toolSelectionEmbed: async (text: string) => {
      const arr = new Float32Array(4);
      for (let i = 0; i < 4; i++) arr[i] = (text.charCodeAt(i) || 0) / 128;
      return arr;
    },
    roleEmbeddingStore: new InMemoryRoleEmbeddingStore(),
    pipelineTelemetrySink: new InMemoryTelemetrySink(),
  } as unknown as ServerDeps;
  mountCompanyKanbanDispatchRoutes(app, deps);
  return {
    app, db, companyStore, sessionId: session.id, dir,
    cardIds: { ready1: ready1.id, ready2: ready2.id, blocked: blocked.id, assigned: assigned.id },
  };
}

function teardown(h: Handle): void {
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

describe('company kanban dispatch/suggest routes (C3)', () => {
  let h: Handle;
  beforeEach(() => { dispatchCardMock.mockReset(); h = setup(); });
  afterEach(() => teardown(h));

  it('suggest-roles: only ready cards (unblocked+unassigned todo/backlog), each with a role', async () => {
    const r = await h.app.request(`/api/company/sessions/${h.sessionId}/kanban/suggest-roles`, {
      method: 'POST',
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { suggestions: Array<{ cardId: number; role: string; score: number }> };
    const ids = body.suggestions.map((s) => s.cardId);
    expect(ids).toContain(h.cardIds.ready1);
    expect(ids).toContain(h.cardIds.ready2);
    // The blocker itself is ready too; blocked + assigned must be excluded.
    expect(ids).not.toContain(h.cardIds.blocked);
    expect(ids).not.toContain(h.cardIds.assigned);
    expect(body.suggestions.length).toBeLessThanOrEqual(5);
    for (const s of body.suggestions) {
      expect(typeof s.role).toBe('string');
      expect(s.role.length).toBeGreaterThan(0);
    }
  });

  it('suggest-roles 404s on unknown session', async () => {
    const r = await h.app.request('/api/company/sessions/99999/kanban/suggest-roles', {
      method: 'POST',
    });
    expect(r.status).toBe(404);
  });

  it('dispatch: forwards cardId + explicit role to orchestrator.dispatchCard', async () => {
    dispatchCardMock.mockResolvedValue({ ok: true, cardId: h.cardIds.ready1, role: 'frontend', agentRunId: 42 });
    const r = await h.app.request(
      `/api/company/sessions/${h.sessionId}/kanban/cards/${h.cardIds.ready1}/dispatch`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'frontend' }) },
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, agentRunId: 42, role: 'frontend' });
    expect(dispatchCardMock).toHaveBeenCalledWith(h.cardIds.ready1, 'frontend');
  });

  it('dispatch: omitted role reaches the orchestrator as undefined (hint/recommender path)', async () => {
    dispatchCardMock.mockResolvedValue({ ok: true, cardId: h.cardIds.ready2, role: 'backend', agentRunId: 7 });
    const r = await h.app.request(
      `/api/company/sessions/${h.sessionId}/kanban/cards/${h.cardIds.ready2}/dispatch`,
      { method: 'POST' },
    );
    expect(r.status).toBe(200);
    expect(dispatchCardMock).toHaveBeenCalledWith(h.cardIds.ready2, undefined);
  });

  it('dispatch: card_not_found → 404, other skips → 409 with the reason', async () => {
    dispatchCardMock.mockResolvedValueOnce({ ok: false, cardId: 999, reason: 'card_not_found' });
    const notFound = await h.app.request(
      `/api/company/sessions/${h.sessionId}/kanban/cards/999/dispatch`,
      { method: 'POST' },
    );
    expect(notFound.status).toBe(404);

    dispatchCardMock.mockResolvedValueOnce({ ok: false, cardId: h.cardIds.ready1, reason: 'spawn_failed', error: 'over cap' });
    const conflict = await h.app.request(
      `/api/company/sessions/${h.sessionId}/kanban/cards/${h.cardIds.ready1}/dispatch`,
      { method: 'POST' },
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ ok: false, reason: 'spawn_failed' });
  });

  it('dispatch 404s on unknown session without touching the orchestrator', async () => {
    const r = await h.app.request('/api/company/sessions/99999/kanban/cards/1/dispatch', {
      method: 'POST',
    });
    expect(r.status).toBe(404);
    expect(dispatchCardMock).not.toHaveBeenCalled();
  });
});
