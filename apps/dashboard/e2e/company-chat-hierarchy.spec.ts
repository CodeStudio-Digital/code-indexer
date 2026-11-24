import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

test('legacy Company chats share their Master in the project tree and collaboration graph', async ({ page, request }) => {
  test.setTimeout(70_000);
  const dataDir = await mkdtemp(join(tmpdir(), 'company-hierarchy-'));
  const electron: string = createRequire(import.meta.url)('electron');
  const backend = spawn(electron, ['--import', 'tsx', 'scripts/testing/collaboration-e2e-backend.ts'], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MCP_INDEX_DB: join(dataDir, 'test.db'), CODESTUDIO_E2E_API_PORT: '0', CODESTUDIO_E2E_DATA_DIR: dataDir,
      MCP_DATA_DIR: dataDir, MCP_RUNTIME_COORDINATION_DIR: join(dataDir, 'coordination') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = once(backend, 'exit');
  try {
    const lines = createInterface({ input: backend.stdout });
    let api = '';
    for await (const line of lines) {
      if (line.startsWith('{"ready":true')) { api = 'http://127.0.0.1:' + JSON.parse(line).port.port; break; }
    }
    expect(api).toBeTruthy();
    const seed = await request.post(api + '/__fixture/company');
    expect(seed.ok(), await seed.text()).toBeTruthy();
    const { primary: [master, unity, qa], other: [anotherMaster, editor], ordinary, sessions } = await seed.json();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('i18n-lang', 'pt-BR');
      localStorage.setItem('chatRightPanelId', 'collaboration');
    });
    await page.route('**/api/**', async route => {
      const { pathname, search } = new URL(route.request().url());
      if (pathname.includes('/collaboration')) return route.fulfill({ response: await request.get(api + pathname + search) });
      if (pathname === '/api/coder/sessions') return route.fulfill({ json: sessions });
      const id = pathname.match(/^\/api\/coder\/sessions\/([^/]+)$/)?.[1];
      if (id) return route.fulfill({ json: { session: sessions.find((s: { id: string }) => s.id === id), messages: [], message_rows: [], linked_projects: [] } });
      if (pathname.endsWith('/worktrees')) return route.fulfill({ json: { projectId: 1, isGit: false, worktrees: [] } });
      if (pathname.endsWith('/providers')) return route.fulfill({ json: { providers: [] } });
      if (pathname.endsWith('/state-summary')) return route.fulfill({ json: { goal: null, tasks: null, todos: [] } });
      if (pathname.includes('/skills')) return route.fulfill({ json: { skills: [] } });
      if (pathname.endsWith('/db-client/connections')) return route.fulfill({ json: { connections: [] } });
      if (pathname.endsWith('/tree')) return route.fulfill({ json: { entries: [], files: [] } });
      if (pathname.endsWith('/status')) return route.fulfill({ json: { active: false } });
      return route.fulfill({ json: [] });
    });
    await page.goto('/e2e/fixtures/session-worktrees.html?projectId=1');
    const row = (id: string) => page.locator('[data-session-id="' + id + '"]');
    for (const id of [master, anotherMaster, ordinary]) await expect(row(id)).toHaveAttribute('data-session-depth', '0');
    for (const id of [qa, unity, editor]) await expect(row(id)).toHaveAttribute('data-session-depth', '1');
    await row(master).getByRole('button', { name: /Recolher chats/ }).click();
    await expect(row(qa)).toHaveCount(0);
    await expect(row(unity)).toHaveCount(0);
    await expect(row(editor)).toBeVisible();
    await row(master).getByRole('button', { name: /Expandir chats/ }).click();
    const graph = page.getByRole('img', { name: 'Grafo de colaboração' });
    for (const [id, title] of [[master, 'Animação master'], [qa, 'Animação qa']]) {
      await row(id).getByRole('button', { name: title, exact: true }).click();
      await expect(graph.getByRole('button')).toHaveCount(3);
      await expect(graph.getByRole('button').first()).toHaveAttribute('aria-label', 'Master');
      await expect(graph.getByRole('button', { name: 'qa', exact: true })).toContainText('Interrompido');
      await expect(graph.getByRole('button', { name: 'editor', exact: true })).toHaveCount(0);
      await graph.getByRole('button', { name: 'unity', exact: true }).click();
      await expect(page.getByRole('link', { name: 'Abrir chat' })).toHaveAttribute('href', '#/projects/1?session=' + unity);
    }
    await page.screenshot({ path: test.info().outputPath('company-chat-hierarchy.png') });
    await page.getByRole('link', { name: 'Abrir chat' }).click();
    await expect.poll(() => new URL(page.url()).hash).toBe('#/projects/1?session=' + unity);
    expect(errors).toEqual([]);
  } finally {
    backend.kill();
    await exited;
    await rm(dataDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});
