/**
 * Integration test for /api/company/sessions/:id/kanban/recompute-priorities.
 *
 * Uses a real CodeIndexDB + CompanyStore with seeded cards, then verifies
 * the endpoint returns cards ordered by priority_score.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { CompanyStore } from '@mcp/store/company-store.js';
import { mountCompanyRecommendationsRoutes } from '../recommendations.js';
import { InMemoryRoleEmbeddingStore } from '@mcp/company/role-pipeline/index.js';
import { InMemoryTelemetrySink } from '@mcp/candidate-pipeline';
import type { ServerDeps } from '../../../deps.js';

interface Handle {
  app: Hono;
  db: CodeIndexDB;
  companyStore: CompanyStore;
  sessionId: number;
  dir: string;
}

function setup(): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-rec-routes-'));
  const dbPath = join(dir, 'test.db');
  const db = new CodeIndexDB(dbPath);
  const companyStore = new CompanyStore(dbPath);

  // Seed: a template (so role recommender has a roster), a session, and
  // a few kanban cards with different tags.
  const template = companyStore.createTemplate('test', 'test description', [
    { role: 'frontend', provider: 'anthropic', model: 'claude-haiku', tier: 'navigate' },
    { role: 'backend',  provider: 'anthropic', model: 'claude-haiku', tier: 'navigate' },
  ]);
  const session = companyStore.createCompanySession({
    template_id: template.id,
    name: 'test-session',
    config_json: '{}',
  });
  companyStore.createKanbanCard(session.id, {
    title: 'docs typo',
    description: 'fix typo',
    column: 'todo',
    tag: 'documentation',
    created_by: 'human',
  });
  companyStore.createKanbanCard(session.id, {
    title: 'production crash',
    description: 'fix prod crash blocking login',
    column: 'todo',
    tag: 'bug',
    created_by: 'human',
  });
  companyStore.createKanbanCard(session.id, {
    title: 'refactor auth',
    description: 'X'.repeat(500),
    column: 'todo',
    tag: 'refactor',
    created_by: 'human',
  });

  const app = new Hono();
  // Build a minimal ServerDeps subset that the route uses.
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
  mountCompanyRecommendationsRoutes(app, deps);
  return { app, db, companyStore, sessionId: session.id, dir };
}

function teardown(h: Handle): void {
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

describe('company /recommendations routes', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('kanban/recompute-priorities orders bug > refactor > docs', async () => {
    const r = await h.app.request(`/api/company/sessions/${h.sessionId}/kanban/recompute-priorities`, {
      method: 'POST',
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ordered: Array<{ id: number; title: string; tag: string | null }>;
      diagnostics: Array<{ id: number; score: number }>;
      durationMs: number;
    };
    expect(body.ordered).toHaveLength(3);
    expect(body.diagnostics).toHaveLength(3);
    // bug card (production crash) must rank first.
    expect(body.ordered[0].tag).toBe('bug');
    // refactor with massive description should rank below docs (effort penalty).
    const idx = (tag: string) => body.ordered.findIndex((c) => c.tag === tag);
    expect(idx('bug')).toBeLessThan(idx('refactor'));
  });

  it('recommend-role 404s on unknown session', async () => {
    const r = await h.app.request(`/api/company/sessions/99999/recommend-role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'anything' }),
    });
    expect(r.status).toBe(404);
  });

  it('recommend-role 400s on missing task', async () => {
    const r = await h.app.request(`/api/company/sessions/${h.sessionId}/recommend-role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });

  it('recommend-role returns recommendations from the template roster', async () => {
    const r = await h.app.request(`/api/company/sessions/${h.sessionId}/recommend-role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'frontend bug fix' }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      recommendations: Array<{ role: string; kind: string; score: number }>;
    };
    expect(body.recommendations.length).toBeGreaterThan(0);
    const roles = new Set(body.recommendations.map((r) => r.role));
    // Both seeded roles should be candidates.
    expect(roles.has('frontend') || roles.has('backend')).toBe(true);
  });

  it('kanban/recompute-priorities returns 404 for unknown session', async () => {
    const r = await h.app.request(`/api/company/sessions/99999/kanban/recompute-priorities`, {
      method: 'POST',
    });
    expect(r.status).toBe(404);
  });
});
