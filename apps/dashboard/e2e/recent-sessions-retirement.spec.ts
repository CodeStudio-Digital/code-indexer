import { expect, test } from '@playwright/test';

test('loads the shell and pins open chats without querying recent sessions', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  const retiredRequests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('mcp-ide:onboarded', 'true');
    localStorage.setItem('i18n-lang', 'pt-BR');
    localStorage.setItem('theme', 'dark');
  });
  const sessions = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'].map((id, index) => ({
    id, title: `Conversa preservada ${index + 1}`, project_id: 7, provider: 'openai', model: 'gpt-test',
    status: 'idle', created_at: '2026-10-24T12:00:00Z', updated_at: '2026-10-24T12:00:00Z',
    group_id: null, is_archived: false, is_favorite: false, agent: 'explore',
    total_input_tokens: 0, total_output_tokens: 0, total_cache_read_tokens: 0, total_cache_creation_tokens: 0,
    last_turn_input_tokens: 0, linked_count: 1, workspace_label: 'Projeto de teste', project_name: 'Projeto de teste',
  }));
  const project = {
    id: 7, name: 'Projeto de teste', root_path: 'D:/fixture/project',
    file_count: 0, symbol_count: 0, chunk_count: 0, last_indexed: null,
  };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/coder/sessions/recent') {
      retiredRequests.push(path);
      return route.fulfill({ status: 410, json: {} });
    }
    if (path === '/api/projects') return route.fulfill({ json: [project] });
    if (path === '/api/projects/7') return route.fulfill({ json: project });
    if (path === '/api/coder/sessions/global' || path === '/api/coder/sessions') return route.fulfill({ json: sessions });
    const session = sessions.find(item => path === `/api/coder/sessions/${item.id}`);
    if (session) return route.fulfill({ json: { session, messages: [], message_rows: [], linked_projects: [project] } });
    if (path.endsWith('/notifications')) return route.fulfill({ json: { notifications: [], unread: 0 } });
    if (path.endsWith('/db-client/connections')) return route.fulfill({ json: { connections: [] } });
    if (path.includes('/skills')) return route.fulfill({ json: { skills: [] } });
    if (path.endsWith('/tree')) return route.fulfill({ json: { entries: [], files: [] } });
    if (path.endsWith('/state-summary')) return route.fulfill({ json: { goal: null, tasks: null, todos: [] } });
    if (path.endsWith('/tasks')) return route.fulfill({ json: null });
    if (path.endsWith('/status')) return route.fulfill({ json: { active: false } });
    if (path === '/api/coder/providers') return route.fulfill({ json: { providers: [], legacy: true } });
    if (path.endsWith('/snapshots') || path.includes('/snapshot')) return route.fulfill({ json: { files: [], reviews: [] } });
    if (path.endsWith('/stats') || path === '/api/config/features') return route.fulfill({ json: {} });
    if (path.endsWith('/state')) return route.fulfill({ json: { todos: [], tasks: [], state: null } });
    if (path === '/api/coder/worktrees') return route.fulfill({ json: { projectId: 7, isGit: false, worktrees: [] } });
    return route.fulfill({ json: [] });
  });

  await page.goto('/#/');
  await expect(page.getByRole('button', { name: 'Abrir Projeto de teste', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Sessões recentes|Recent sessions/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'Buscar em todo lugar', exact: true }).click();
  const palette = page.getByRole('dialog');
  await expect(palette.getByRole('button', { name: 'Projeto de teste', exact: true })).toBeVisible();
  await expect(palette.getByText('Sessões recentes', { exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: '.tmp/recent-sessions-removed.png' });

  for (const session of sessions) {
    await page.goto(`/#/global?session=${session.id}`);
    await expect(page.locator('[data-session-id]').filter({ hasText: session.title })).toBeVisible();
    await page.getByRole('button', { name: 'Fixar esta visão', exact: true }).click();
    await expect(page.getByRole('tablist', { name: 'Abas fixadas' })).toContainText(session.title);
  }
  expect(retiredRequests).toEqual([]);
  expect(errors).toEqual([]);
});
