import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpRouter } from '@mcp/shared/http/router.js';
import { cors } from '@mcp/shared/http/middleware.js';
import { listenHttp } from '@mcp/shared/http/node-server.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import { CompanyWorkspaceCoordinator } from '@mcp/company/services/workspace-coordinator.js';
import { createDesignTestHost } from '../../http-api/server/routes/company/__tests__/designer-fixture.js';
import { mountCompanyAgentControlRoutes } from '../../http-api/server/routes/company/agents.js';
import { mountCompanyAutonomyRoutes } from '../../http-api/server/routes/company/autonomy.js';
import { mountNotificationRoutes } from '../../http-api/server/routes/notifications.js';

test('changes projects, assignments, rules, autonomy, agents and reviewed operations on one open Company panel', async ({ page, baseURL }) => {
  const root = await mkdtemp(join(tmpdir(), 'company-panel-browser-'));
  let server: Server | undefined;
  try {
    const host = await createDesignTestHost(root, { reply: '', changes: {} });
    const app = host.router();
    mountCompanyAutonomyRoutes(app, host.config);
    mountCompanyAgentControlRoutes(app, host.config);
    mountNotificationRoutes(app, host.config);
    const uiOrigin = new URL(baseURL!).origin;
    const http = new HttpRouter();
    http.use('*', cors({ origin: origin => origin === uiOrigin ? origin : undefined }));
    http.route('/', app);
    server = listenHttp({ fetch: http.fetch, hostname: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const api = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const company = await host.sessions.createCompanySession({
      name: 'Empresa de teste', project_ids: [1],
      config_json: JSON.stringify({ autonomy: { scheduler: false, supervisorMaster: false }, role_assignments: [
        { role: 'master', provider: 'chatgpt', model: 'sol', tier: 'navigate' },
        { role: 'revisor', provider: 'chatgpt', model: 'sol', tier: 'navigate', projectIds: [1] },
      ] }),
    });
    const files = new CompanySessionFiles({ companySessionId: company.id, sessionStore: host.store });
    const agent = await files.createAgentRun({ role: 'revisor', provider: 'chatgpt', model: 'sol', project_ids: [1], coder_session_id: randomUUID(), status: 'paused' });
    const coordinator = new CompanyWorkspaceCoordinator(files.location.bundle_path);
    await coordinator.run({ sessionId: company.id, agentRunId: agent.id, toolName: 'synthetic-check', toolUseId: 'operation-74',
      pendingEffects: () => [new Promise<void>(() => {})] }, async () => 'yielded', () => false);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(url => url.origin === uiOrigin && url.pathname.startsWith('/api/'), route => {
      const url = new URL(route.request().url());
      return route.continue({ url: api + url.pathname + url.search });
    });
    await page.addInitScript(origin => {
      Object.assign(window, { __MCP_API_BASE__: origin });
      localStorage.setItem('agentsSidebar.section.projects', '0');
    }, api);
    await page.goto('/e2e/fixtures/company-designer.html?session=' + company.id);
    await page.getByRole('button', { name: 'Equipe e configuração' }).click();
    // Holding the original DOM node also detects a panel remount at the same URL.
    const section = page.getByRole('button', { name: /^Projetos\s*\d/ });
    const original = await section.elementHandle();
    await expect(section).toHaveAttribute('aria-expanded', 'false');
    await page.getByTitle('Add project', { exact: true }).click();
    await page.getByRole('combobox', { name: 'Projetos' }).selectOption('2');
    await page.getByRole('button', { name: 'Vincular projeto' }).click();
    await expect(section).toHaveText(/Projetos\s*2/);
    const badge = page.getByTitle('Click to rename').filter({ hasText: 'Intranet' });
    await expect(badge).toBeVisible();
    const assignments = page.getByText('Intranet', { exact: true }).locator('xpath=../..').filter({ has: page.getByTitle('Adicionar papel', { exact: true }) });
    await assignments.getByTitle('Adicionar papel').click();
    await assignments.getByRole('button', { name: 'revisor', exact: true }).click();
    const bound = page.getByText('Intranet', { exact: true }).locator('xpath=../..').getByTitle('Desvincular', { exact: true });
    await expect(bound).toBeVisible();
    expect(JSON.parse(files.getSession().config_json).role_assignments[1].projectIds).toEqual([1, 2]);
    await bound.click();
    await expect(bound).toHaveCount(0);
    await page.getByTitle('Unlink project from session').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Desvincular' }).click();
    await expect(section).toHaveText(/Projetos\s*1/);
    await expect(badge).toHaveCount(0);
    expect(files.getSession().project_ids).toEqual([1]);

    await page.getByRole('button', { name: 'Regras operacionais' }).click();
    await page.getByPlaceholder(/Regras obrigatórias/).fill('Usar o projeto vinculado.');
    const save = page.getByRole('button', { name: 'Salvar regras' });
    await save.click();
    await expect(save).toBeDisabled();
    await expect(page.getByText('Salvo', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Autonomia', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Scheduler autônomo' }).check();
    await page.getByRole('checkbox', { name: 'Supervisor do master' }).check();
    await expect.poll(() => JSON.parse(files.getSession().config_json)).toMatchObject({
      operational_rules: 'Usar o projeto vinculado.', autonomy: { scheduler: true, supervisorMaster: true },
    });
    // A second client changes the same idle Company. Only the real app-wide SSE
    // can trigger a reload of the mounted autonomy panel and rule editor here.
    const external = await page.request.patch(api + '/api/company/sessions/' + company.id + '/config', {
      data: { autonomy: { scheduler: false }, operational_rules: 'Revisado em outra janela.' },
    });
    expect(external.ok()).toBe(true);
    await expect(page.getByRole('checkbox', { name: 'Scheduler autônomo' })).not.toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Supervisor do master' })).toBeChecked();
    await expect(page.getByPlaceholder(/Regras obrigatórias/)).toHaveValue('Revisado em outra janela.');
    const release = page.getByRole('button', { name: 'Liberar operações revisadas' });
    await expect(release).toBeDisabled();
    await page.getByLabel('Conferi o estado das operações listadas.').check();
    await release.click();
    await expect(page.getByText('operation-74', { exact: true })).toHaveCount(0);
    expect(await coordinator.owners()).toEqual([]);
    await page.getByRole('button', { name: 'Excluir agente', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Excluir agente' }).click();
    await expect(page.getByRole('button', { name: 'Excluir agente', exact: true })).toHaveCount(0);
    await expect(page.getByText('Nenhum agente ainda.', { exact: false })).toBeVisible();
    expect(files.getAgentRunSync(agent.id)).toBeNull();
    expect(await original!.evaluate(el => el.isConnected)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    if (server) { server.closeAllConnections(); await new Promise<void>(done => server!.close(() => done())); }
    await rm(root, { recursive: true, force: true });
  }
});
