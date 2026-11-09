import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { asSessionId } from '@mcp/agent-runtime-contracts';
import type { ServerDeps } from '../../../deps.js';
import type { CoderRuntime } from '../state.js';
import { mountCoderSessionsRoutes } from '../sessions.js';

const pool = vi.hoisted(() => ({ getBus: vi.fn(), isRunning: vi.fn(), snapshot: vi.fn() }));
vi.mock('../../../../sse/coderWorkerPoolSingleton.js', () => ({ getCoderWorkerPool: () => pool }));
const id = asSessionId('11111111-1111-4111-8111-111111111111');
function setup(running: boolean, ended: boolean) {
  pool.getBus.mockReturnValue({ busId: 'run-a', ended, nextSeq: 4 });
  pool.isRunning.mockReturnValue(running);
  pool.snapshot.mockReturnValue([{ sessionId: id }]);
  const list = vi.fn(async () => [{ id, status: 'in_progress' }]);
  const app = new Hono();
  mountCoderSessionsRoutes(app, { sessionStore: { listSessions: list, listGlobalSessions: list }, providerStore: {} } as unknown as ServerDeps, {} as CoderRuntime);
  return { app, list };
}
describe('authoritative session activity routes', () => {
  it('does not count an idle cached worker with an unended bus as executing', async () => {
    const { app, list } = setup(false, false);
    expect(await (await app.request(`/api/coder/sessions/${id}/status`)).json()).toMatchObject({ active: false });
    expect(await (await app.request('/api/coder/activity')).json()).toEqual({ active: [] });
    expect(list).not.toHaveBeenCalled();
  });
  it('overrides stale persisted activity on project and global lists', async () => {
    const { app } = setup(false, true);
    for (const url of ['/api/coder/sessions?project_id=7', '/api/coder/sessions/global']) {
      expect(await (await app.request(url)).json()).toEqual([{ id, status: 'in_progress', runtime_active: false, runtime_bus_id: 'run-a' }]);
    }
  });
  it('counts a live worker and excludes a terminal bus immediately', async () => {
    const { app } = setup(true, false);
    expect(await (await app.request('/api/coder/activity')).json()).toEqual({ active: [{ session_id: id, bus_id: 'run-a' }] });
    pool.getBus.mockReturnValue({ busId: 'run-a', ended: true });
    expect(await (await app.request('/api/coder/activity')).json()).toEqual({ active: [] });
  });
});
