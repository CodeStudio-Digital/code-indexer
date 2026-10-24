import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import { createOwnedAgentReads } from '../owned-agent-reads.js';

afterEach(() => { vi.unstubAllGlobals(); });
function fixture(project = 7, profile: string | null = null) {
  const row = { id: 'fixture', project_id: project, metadata: { mcp_agent_run: {
    schema_version: 1, principal: 'local-dev', profile_id: profile, agent_id: 'explore', task_preview: 'task',
  } } };
  const app = new Hono(); const detail = vi.fn();
  app.get('/api/coder/sessions/:id', c => { detail(); return c.json({ session: row,
    runtime_outcome: { runtimeGeneration: 'rust_v1', status: 'failed', reason: 'owned_failure' },
    messages: [{ role: 'assistant', content: 'partial' }] }); });
  app.get('/api/coder/agents', c => c.json({ agents: [{ id: 'owned-agent' }] }));
  app.get('/api/coder/providers', c => c.json({ providers: [{ id: 'owned-provider' }] }));
  const list = vi.fn(async () => ({ items: [row] }));
  const service = createOwnedAgentReads(app, { config: { dashboard: { port: 9999 } }, sessionStore: {
    getSession: vi.fn(async () => row), listMcpRunMetadata: list,
  } } as any);
  const fetch = vi.fn(() => { throw new Error('Unowned TCP endpoint'); }); vi.stubGlobal('fetch', fetch);
  return { service, detail, list, fetch, signal: new AbortController().signal };
}

it('uses the owning Hono instance for catalog and durable result, without TCP discovery', async () => {
  const f = fixture();
  expect(await f.service.read(7, 'list_agents', {}, f.signal)).toMatchObject({ agents: { agents: [{ id: 'owned-agent' }] } });
  expect(await f.service.read(7, 'get_agent_result', { run_id: 'fixture' }, f.signal)).toMatchObject({
    run_id: 'fixture', status: 'failed', result: 'partial', error: 'owned_failure',
  });
  expect(f.fetch).not.toHaveBeenCalled();
});

it.each([[8, null], [7, 'foreign-profile']] as const)('rejects foreign project/profile before transcript hydration', async (project, profile) => {
  const f = fixture(project, profile);
  await expect(f.service.read(7, 'get_agent_run', { run_id: 'fixture', project_id: project }, f.signal)).rejects.toThrow('Unknown agent run');
  expect(f.detail).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
});

it('pins list pagination and principal to the Host project before hydration', async () => {
  const f = fixture();
  await f.service.read(7, 'list_agent_runs', { limit: 2, project_id: 900, principal: 'foreign' }, f.signal);
  expect(f.list).toHaveBeenCalledWith(expect.objectContaining({ projectId: 7, principal: 'local-dev', profileId: null, limit: 2 }));
  expect(f.fetch).not.toHaveBeenCalled();
});

it('rejects cancelled and non-read requests before application dispatch', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await expect(f.service.read(7, 'get_agent_result', { run_id: 'fixture' }, controller.signal)).rejects.toThrow('cancelled');
  await expect(f.service.read(7, 'start_agent_run' as any, {}, f.signal)).rejects.toThrow('Unknown owned agent read');
  expect(f.detail).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
});
