import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { CodeIndexDB } from '@mcp/store/db.js';
import { mountAgentMemoryEvolutionRoutes } from '../agent-memory-evolution.js';

let root: string, db: CodeIndexDB, projectId: number;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'memory-overview-')); db = new CodeIndexDB(join(root, 'index.db'));
  projectId = db.createProject('Fixture', join(root, 'project')).id;
  db.createAgentMemory({ projectId, name: 'manual rule', content: 'Preserve the fixture', source: 'manual' });
});
afterAll(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
function fixture(enabled = true) {
  const evolution = { status: vi.fn(() => ({ enabled, pending: 1, running: false })), enabled: () => enabled, runOnce: vi.fn(async () => undefined) };
  const app = new Hono(); mountAgentMemoryEvolutionRoutes(app, { db, memoryEvolution: evolution } as any);
  return { app, evolution };
}
it('serves one consistent overview from the live store without starting learning or reading chat histories', async () => {
  const { app, evolution } = fixture();
  const response = await app.request(`/api/projects/${projectId}/agent-memory/overview`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ enabled: true, totals: { total: 1 }, usage: { liveProject: 1 }, evolution: { pending: 1 } });
  expect(evolution.runOnce).not.toHaveBeenCalled();
  expect((await app.request('/api/projects/99999/agent-memory/overview')).status).toBe(404);
});
it('schedules a bounded review and rejects work when automatic learning is disabled', async () => {
  const { app, evolution } = fixture();
  expect((await app.request(`/api/projects/${projectId}/agent-memory/evolution`, { method: 'POST' })).status).toBe(202);
  expect(evolution.runOnce).toHaveBeenCalledExactlyOnceWith({ scope: 'project', projectId });
  const off = fixture(false);
  expect((await off.app.request(`/api/projects/${projectId}/agent-memory/evolution`, { method: 'POST' })).status).toBe(409);
  expect(off.evolution.runOnce).not.toHaveBeenCalled();
});
