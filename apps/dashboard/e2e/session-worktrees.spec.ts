import { expect, test } from '@playwright/test';
test.use({ screenshot: 'only-on-failure' });

test('worktree toolbar scopes sessions, creates multiple sessions and preserves main', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.stack); });
  await page.addInitScript(() => {
    localStorage.setItem('i18n-lang', 'pt-BR');
    localStorage.removeItem('chatRightPanelId');
  });
  const mainId = '11111111-1111-4111-8111-111111111111';
  const featureId = '22222222-2222-4222-8222-222222222222';
  const worktrees = [
    { path: 'D:/fixture/project', branch: 'main', head: 'abc', primary: true, locked: false, prunable: false },
    { path: 'D:/fixture/project/.mcp-indexer/worktrees/feature', branch: 'codex/feature', head: 'abc', primary: false, locked: false, prunable: false },
  ];
  const makeSession = (id: string, title: string, path: string | null) => ({
    id, title, project_id: 7, worktree_path: path, provider: 'openai', model: 'gpt-test', status: 'idle',
    created_at: '2026-10-24T12:00:00Z', updated_at: '2026-10-24T12:00:00Z', group_id: null, is_archived: false,
    is_favorite: false, total_input_tokens: 0, total_output_tokens: 0, total_cache_read_tokens: 0,
    total_cache_creation_tokens: 0, last_turn_input_tokens: 0, agent: 'code',
  });
  const sessions = [makeSession(mainId, 'Sessão do workspace principal', null), makeSession(featureId, 'Implementar feature isolada', worktrees[1]!.path)];
  const createdBodies: Array<Record<string, unknown>> = [];
  const deletedBodies: Array<{ ids: string[] }> = [];
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path.endsWith('/db-client/connections')) return route.fulfill({ json: { connections: [] } });
    if (path.includes('/skills')) return route.fulfill({ json: { skills: [] } });
    if (path.endsWith('/tree')) return route.fulfill({ json: { entries: [], files: [] } });
    if (path.endsWith('/state-summary')) return route.fulfill({ json: { goal: null, tasks: null, todos: [] } });
    if (path === '/api/coder/worktrees') {
      if (method === 'POST') {
        const body = route.request().postDataJSON();
        const item = { ...worktrees[1]!, path: `D:/fixture/project/.mcp-indexer/worktrees/${body.name}`, branch: body.branch };
        worktrees.push(item);
        return route.fulfill({ status: 201, json: { ok: true, path: item.path, branch: item.branch } });
      }
      return route.fulfill({ json: { projectId: 7, isGit: true, worktrees } });
    }
    if (path === '/api/coder/sessions') {
      if (method === 'POST') {
        const body = route.request().postDataJSON(); createdBodies.push(body);
        const id = `33333333-3333-4333-8333-${String(createdBodies.length).padStart(12, '0')}`;
        const session = makeSession(id, `Nova sessão ${createdBodies.length}`, body.worktree_path);
        sessions.push(session);
        return route.fulfill({ status: 201, json: session });
      }
      return route.fulfill({ json: sessions });
    }
    if (path.endsWith('/batch-delete')) {
      deletedBodies.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    }
    const id = path.match(/^\/api\/coder\/sessions\/([^/]+)$/)?.[1];
    if (id) return route.fulfill({ json: { session: sessions.find(item => item.id === id), messages: [], message_rows: [], linked_projects: [] } });
    if (path.endsWith('/status')) return route.fulfill({ json: { active: false } });
    if (path === '/api/coder/providers') return route.fulfill({ json: { providers: [], legacy: true } });
    if (path.endsWith('/snapshots') || path.includes('/snapshot')) return route.fulfill({ json: { files: [], reviews: [] } });
    if (path.endsWith('/stats')) return route.fulfill({ json: {} });
    if (path.endsWith('/state')) return route.fulfill({ json: { todos: [], tasks: [], state: null } });
    return route.fulfill({ json: [] });
  });

  await page.goto('/e2e/fixtures/session-worktrees.html');
  const bar = page.getByTestId('session-workspace-bar');
  await expect(bar).toBeVisible();
  const rows = page.getByRole('complementary').locator('[data-session-id]');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Sessão do workspace principal');
  const newSession = bar.getByRole('button', { name: 'Nova', exact: true });
  await expect(newSession).toBeVisible();
  await expect(page.getByRole('complementary').getByRole('button', { name: 'Nova', exact: true })).toHaveCount(0);
  const barBox = (await bar.boundingBox())!;
  const sidebarBox = (await page.getByRole('complementary').boundingBox())!;
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(sidebarBox.y + 1);
  expect(barBox.width).toBeGreaterThan(sidebarBox.width * 2);

  await bar.getByRole('tab', { name: 'codex/feature' }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Implementar feature isolada');
  await expect(bar.getByRole('tab', { name: 'codex/feature' })).toHaveAttribute('data-state', 'active');
  await newSession.click();
  await expect.poll(() => createdBodies.length).toBe(1);
  expect(createdBodies[0]!.worktree_path).toBe(worktrees[1]!.path);
  await expect(rows).toHaveCount(2);
  await newSession.click();
  await expect.poll(() => createdBodies.length).toBe(2);
  await expect(rows).toHaveCount(3);
  await bar.getByRole('tab', { name: /Principal/ }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Sessão do workspace principal');

  await bar.getByRole('button', { name: 'Novo worktree', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nome do worktree').fill('review');
  await dialog.getByRole('button', { name: 'Novo worktree', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(bar.getByRole('tab', { name: 'codex/review' })).toHaveAttribute('data-state', 'active');
  await expect(rows).toHaveCount(0);
  await newSession.click();
  await expect.poll(() => createdBodies.length).toBe(3);
  expect(createdBodies[2]!.worktree_path).toContain('/worktrees/review');
  await expect(rows).toHaveCount(1);
  await page.reload();
  await expect(bar.getByRole('tab', { name: 'codex/review' })).toHaveAttribute('data-state', 'active');
  await expect(rows).toHaveCount(1);
  await rows.first().click();
  await expect(page.locator('main')).toContainText('Nova sessão 3');
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await page.screenshot({ path: `.tmp/worktree-validation/workbench-${test.info().project.name}.png`, fullPage: true });
  // Delete-all applies to this checkout, never all project sessions.
  await bar.getByRole('button', { name: 'Apagar todas', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Excluir|Apagar/ }).click();
  await expect.poll(() => deletedBodies.length).toBe(1);
  expect(deletedBodies[0]!.ids).toEqual([sessions.at(-1)!.id]);
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(newSession).toBeVisible();
  const narrow = (await bar.boundingBox())!;
  expect(narrow.x + narrow.width).toBeLessThanOrEqual(601);
  await page.screenshot({ path: `.tmp/worktree-validation/workbench-narrow-${test.info().project.name}.png`, fullPage: true });
  // A removed checkout stays visible as unavailable; new sessions cannot fall back to main.
  worktrees.pop();
  await bar.getByRole('button', { name: 'Atualizar worktrees' }).click();
  await expect(bar.getByRole('alert')).toContainText('indisponível');
  await expect(newSession).toBeDisabled();
  await bar.getByRole('tab', { name: /Principal/ }).click();
  await expect(newSession).toBeEnabled();
  await expect(bar.getByRole('tab', { name: 'review', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
