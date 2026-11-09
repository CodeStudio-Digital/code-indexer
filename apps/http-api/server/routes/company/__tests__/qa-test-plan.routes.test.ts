import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { companyFixture } from '@mcp/company/services/__tests__/company-multisession-fixture.js';
import { QaTestRunStore } from '@mcp/services/qa/store/qa-test-run-store.js';
import { mountQaTestPlanRoutes } from '../qa/test-plan.js';
import { mountQaRestoreConfigRoute } from '../qa/restore-config.js';
import type { ServerDeps } from '../../../deps.js';

const sandbox = vi.hoisted(() => ({
  get: vi.fn(), getService: vi.fn(), readWorkspaceFileOnService: vi.fn(), writeWorkspaceFileOnService: vi.fn(),
}));
vi.mock('@mcp/services/sandbox/index.js', () => ({ tryGetSandboxManager: () => sandbox }));
beforeEach(() => { vi.resetAllMocks(); sandbox.readWorkspaceFileOnService.mockRejectedValue(new Error('SandboxManager has no driver wired')); });
async function fixture() {
  const f = await companyFixture();
  const store = new QaTestRunStore(f.sessionStore);
  const app = new Hono();
  mountQaTestPlanRoutes(app, { sessionStore: f.sessionStore, qaTestRunStore: store } as unknown as ServerDeps);
  mountQaRestoreConfigRoute(app, {} as ServerDeps);
  const url = (id = f.child.id, service = 'main') => `/api/company/sessions/${id}/qa/test-plan?service=${service}`;
  const start = (id = f.child.id, service = 'main', name = 'Contrato visível') => store.startRun({ company_session_id: id, agent_run_id: null,
    suite: 'Validação comercial', service_id: service, executor: 'preview', target_url: 'http://localhost:4567',
    criteria: [{ name, selector: '[data-contract]' }], trigger: 'agent' });
  return { ...f, store, app, url, start };
}
describe('QA plan without a sandbox', () => {
  it('never reports a successful legacy config restore without a sandbox', async () => {
    const f = await fixture();
    const response = await f.app.request(`/api/company/sessions/${f.child.id}/qa/restore-config`, { method: 'POST' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: 'no-sandbox' });
    expect(sandbox.writeWorkspaceFileOnService).not.toHaveBeenCalled();
  });
  it('returns the empty state for idle and failed sessions without touching the driver', async () => {
    const f = await fixture();
    for (const status of ['idle', 'error'] as const) {
      await f.files(f.child.id).updateSessionStatus(status);
      const response = await f.app.request(f.url());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ exists: false, content: '', source: 'none' });
    }
    expect(sandbox.readWorkspaceFileOnService).not.toHaveBeenCalled();
  });
  it('loads real persisted preview criteria after reopening the run store', async () => {
    const f = await fixture(); const run = await f.start(); f.store.close();
    const response = await f.app.request(f.url());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ exists: true, source: 'preview', run_id: run.id,
      target_url: 'http://localhost:4567', criteria: [{ name: 'Contrato visível', selector: '[data-contract]' }] });
    expect(sandbox.readWorkspaceFileOnService).not.toHaveBeenCalled();
  });
  it('isolates both session and service when another run is newer', async () => {
    const f = await fixture(); const main = await f.start();
    const api = await f.start(f.child.id, 'api', 'Resposta da API');
    await f.start(f.company.id, 'main', 'Outra sessão');
    expect(await (await f.app.request(f.url())).json()).toMatchObject({ run_id: main.id });
    expect(await (await f.app.request(f.url(f.child.id, 'api'))).json()).toMatchObject({ run_id: api.id });
    expect(await (await f.app.request(f.url(f.foreign.id))).json()).toMatchObject({ exists: false });
  });
  it('rejects unknown sessions and invalid service names', async () => {
    const f = await fixture();
    expect((await f.app.request(f.url(randomUUID() as typeof f.child.id))).status).toBe(404);
    expect((await f.app.request(f.url(f.child.id, '../other'))).status).toBe(400);
  });
  it('keeps legacy workspace plans readable and writable on the selected service', async () => {
    const f = await fixture(); sandbox.getService.mockReturnValue({ containerId: 'api-container' });
    sandbox.readWorkspaceFileOnService.mockResolvedValue('### API\n- Contrato existente');
    const response = await f.app.request(f.url(f.child.id, 'api'));
    expect(await response.json()).toMatchObject({ exists: true, source: 'sandbox', content: '### API\n- Contrato existente' });
    expect(sandbox.readWorkspaceFileOnService).toHaveBeenCalledWith(f.child.id, 'api', 'tests/e2e/TEST_PLAN.md');
    sandbox.writeWorkspaceFileOnService.mockResolvedValue(undefined);
    const write = await f.app.request(f.url(f.child.id, 'api'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Plano atualizado' }) });
    expect(write.status).toBe(200);
    expect(sandbox.writeWorkspaceFileOnService).toHaveBeenCalledWith(f.child.id, 'api', 'tests/e2e/TEST_PLAN.md', 'Plano atualizado');
  });
  it('distinguishes absent workspace from real I/O failures and enforces a byte limit', async () => {
    const f = await fixture();
    const put = (content: string) => f.app.request(f.url(), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
    expect((await put('plan')).status).toBe(409);
    expect((await put('é'.repeat(110_000))).status).toBe(413);
    sandbox.get.mockReturnValue({ containerId: 'primary' });
    sandbox.readWorkspaceFileOnService.mockRejectedValue(new Error('Container read failed'));
    expect((await f.app.request(f.url())).status).toBe(500);
  });
});
