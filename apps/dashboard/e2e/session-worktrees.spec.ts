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
  const makeSession = (id: string, title: string, path: string | null, parentId: string | null = null) => ({
    id, title, project_id: 7, parent_session_id: parentId, worktree_path: path, provider: 'openai', model: 'gpt-test', status: 'idle',
    created_at: '2026-10-24T12:00:00Z', updated_at: '2026-10-24T12:00:00Z', group_id: null, is_archived: false,
    is_favorite: false, total_input_tokens: 0, total_output_tokens: 0, total_cache_read_tokens: 0,
    total_cache_creation_tokens: 0, last_turn_input_tokens: 0, agent: 'code',
  });
  const sessions = [makeSession(mainId, 'Sessão do workspace principal', null), makeSession(featureId, 'Implementar feature isolada', worktrees[1]!.path)];
  const createdBodies: Array<Record<string, unknown>> = [];
  const deletedBodies: Array<{ ids: string[] }> = [];
  const removals: Array<{ path: string; confirmed: boolean; deleteBranch: boolean; discardChanges: boolean }> = [];
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path.endsWith('/db-client/connections')) return route.fulfill({ json: { connections: [] } });
    if (path.includes('/skills')) return route.fulfill({ json: { skills: [] } });
    if (path.endsWith('/tree')) return route.fulfill({ json: { entries: [], files: [] } });
    if (path.endsWith('/state-summary')) return route.fulfill({ json: { goal: null, tasks: null, todos: [] } });
    if (path === '/api/coder/worktrees/remove' && method === 'POST') {
      const body = route.request().postDataJSON();
      removals.push(body);
      const index = worktrees.findIndex(item => item.path === body.path);
      if (index < 1) return route.fulfill({ status: 409, json: { code: 'changed' } });
      if (worktrees[index]!.branch === 'codex/feature' && !body.discardChanges) {
        return route.fulfill({ status: 409, json: { code: 'dirty', error: 'dirty' } });
      }
      worktrees.splice(index, 1);
      return route.fulfill({ json: { removed: true, branchDeleted: body.deleteBranch } });
    }
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
      const body = route.request().postDataJSON() as { ids: string[] };
      deletedBodies.push(body);
      const items = body.ids.map(session_id => ({ session_id }));
      for (const id of body.ids) {
        const index = sessions.findIndex(session => session.id === id);
        if (index >= 0) sessions.splice(index, 1);
      }
      return route.fulfill({ json: { ok: true, deleted: items.length, items } });
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
  const picker = bar.getByRole('button', { name: /Alternar worktree/ });
  const choose = async (name: string) => {
    await picker.click();
    await page.getByRole('dialog', { name: 'Worktrees do projeto' }).getByRole('button', { name, exact: true }).click();
  };
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

  await choose('codex/feature');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Implementar feature isolada');
  await expect(picker).toContainText('codex/feature');
  const child = makeSession('44444444-4444-4444-8444-444444444444', 'Investigar evidências', worktrees[1]!.path, featureId);
  const fork = makeSession('55555555-5555-4555-8555-555555555555', 'Revisar hipóteses', worktrees[1]!.path, child.id);
  sessions.unshift(fork, child);
  await page.evaluate(async ({ modulePath, parent, childId }) => {
    const { TurnProjector } = await import(modulePath);
    const stream = new TurnProjector({ sessionId: parent, updateSession: () => {} });
    stream.dispatch('chat_session_created', { sessionId: childId });
    stream.dispose();
  }, { modulePath: '/hooks/agent-stream/turn-projector.ts', parent: featureId, childId: child.id });
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute('data-session-id', featureId);
  await expect(rows.nth(1)).toHaveAttribute('data-session-depth', '1');
  await expect(rows.nth(2)).toHaveAttribute('data-session-depth', '2');
  await rows.first().getByRole('button', { name: 'Recolher chats derivados de Implementar feature isolada' }).click();
  await expect(rows).toHaveCount(1);
  await rows.first().getByRole('button', { name: 'Expandir chats derivados de Implementar feature isolada' }).press('Enter');
  await expect(rows).toHaveCount(3);

  const treeTitles = [
    rows.nth(0).getByRole('button', { name: 'Implementar feature isolada', exact: true }),
    rows.nth(1).getByRole('button', { name: child.title, exact: true }),
    rows.nth(2).getByRole('button', { name: fork.title, exact: true }),
  ];
  const [rootTitle, childTitle, grandchildTitle] = await Promise.all(treeTitles.map(title => title.boundingBox()));
  expect(rootTitle!.height).toBeLessThanOrEqual(30);
  expect(childTitle!.x - rootTitle!.x).toBeGreaterThanOrEqual(9);
  expect(grandchildTitle!.x - childTitle!.x).toBeCloseTo(childTitle!.x - rootTitle!.x);
  await expect(treeTitles[1]).toHaveAccessibleDescription(/gpt-test.*0 tokens/);
  await treeTitles[1]!.focus();
  const childActions = rows.nth(1).getByRole('button', { name: 'Ações da sessão', exact: true });
  await expect(childActions.locator('..')).toHaveCSS('opacity', '1');
  expect((await childActions.boundingBox())!.x).toBeGreaterThan(childTitle!.x + childTitle!.width);
  await childActions.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Renomear', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await rows.nth(2).getByRole('button', { name: 'Revisar hipóteses', exact: true }).click();
  await expect(page.locator('main')).toContainText('Revisar hipóteses');
  await page.getByRole('complementary').screenshot({ path: test.info().outputPath('session-tree.png') });
  await newSession.click();
  await expect.poll(() => createdBodies.length).toBe(1);
  expect(createdBodies[0]!.worktree_path).toBe(worktrees[1]!.path);
  await expect(rows).toHaveCount(4);
  await newSession.click();
  await expect.poll(() => createdBodies.length).toBe(2);
  await expect(rows).toHaveCount(5);
  await choose('Principal');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Sessão do workspace principal');

  await bar.getByRole('button', { name: 'Novo worktree', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nome do worktree').fill('review');
  await dialog.getByRole('button', { name: 'Novo worktree', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(picker).toContainText('codex/review');
  await expect(rows).toHaveCount(0);
  await newSession.click();
  await expect.poll(() => createdBodies.length).toBe(3);
  expect(createdBodies[2]!.worktree_path).toContain('/worktrees/review');
  await expect(rows).toHaveCount(1);
  await page.reload();
  await expect(picker).toContainText('codex/review');
  await expect(rows).toHaveCount(1);
  await rows.first().click();
  await expect(page.locator('main')).toContainText('Nova sessão 3');
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await page.screenshot({ path: `.tmp/worktree-validation/workbench-${test.info().project.name}.png`, fullPage: true });
  // Delete-all applies to this checkout, never all project sessions.
  const reviewSessionId = sessions.at(-1)!.id;
  await bar.getByRole('button', { name: 'Apagar todas', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Excluir|Apagar/ }).click();
  await expect.poll(() => deletedBodies.length).toBe(1);
  expect(deletedBodies[0]!.ids).toEqual([reviewSessionId]);
  await expect(rows).toHaveCount(0);
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(newSession).toBeVisible();
  const narrow = (await bar.boundingBox())!;
  expect(narrow.x + narrow.width).toBeLessThanOrEqual(601);
  await page.screenshot({ path: `.tmp/worktree-validation/workbench-narrow-${test.info().project.name}.png`, fullPage: true });
  // The history of a removed checkout stays reachable; new sessions cannot fall back to main.
  await newSession.click();
  await expect(rows).toHaveCount(1);
  worktrees.pop();
  await bar.getByRole('button', { name: 'Atualizar worktrees' }).click();
  await expect(bar.getByRole('alert')).toContainText('indisponível');
  await expect(newSession).toBeDisabled();
  await choose('Principal');
  await expect(newSession).toBeEnabled();
  await picker.click();
  const history = page.getByRole('list', { name: 'Histórico de chats' });
  await expect(history.getByRole('button', { name: 'review', exact: true })).toBeVisible();
  await expect(history.getByRole('button', { name: /Excluir worktree/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  const feature = worktrees[1]!;
  const inactive = { ...feature, branch: 'claude/another', path: 'D:/fixture/checkout in QA' };
  worktrees.push(inactive, { ...feature, branch: 'locked', path: 'D:/fixture/locked', locked: true });
  for (let index = 0; index < 20; index++) worktrees.push({ ...feature, branch: 'review/' + index, path: 'D:/fixture/reviews/' + index });
  await bar.getByRole('button', { name: 'Atualizar worktrees' }).click();
  await picker.click();
  const menu = page.getByRole('dialog', { name: 'Worktrees do projeto' });
  const filter = menu.getByRole('textbox', { name: 'Filtrar por branch ou caminho' });
  await expect(menu.getByRole('button', { name: 'locked', exact: true })).toBeAttached();
  await expect(menu.getByRole('button', { name: /Excluir worktree (Principal|locked)/ })).toHaveCount(0);
  await filter.fill('CoDeX/FEAt');
  await filter.press('ArrowDown');
  await expect(menu.getByRole('button', { name: 'codex/feature', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(picker).toContainText('codex/feature');
  const requestRemoval = async (search: string, branch: string) => {
    await picker.click();
    await filter.fill(search);
    await menu.getByRole('button', { name: 'Excluir worktree ' + branch, exact: true }).click();
    return page.getByRole('dialog', { name: 'Excluir worktree ' + branch, exact: true });
  };
  let confirm = await requestRemoval('in qa', inactive.branch);
  await expect(confirm).toContainText(inactive.path);
  await expect(confirm.getByRole('button', { name: 'Cancelar' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveCount(0);
  expect(removals).toHaveLength(0);
  confirm = await requestRemoval('in qa', inactive.branch);
  await confirm.getByRole('button', { name: 'Excluir worktree', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  expect(removals[0]).toMatchObject({ path: inactive.path, confirmed: true, discardChanges: false, deleteBranch: false });
  await expect(picker).toContainText(feature.branch);
  confirm = await requestRemoval(feature.branch, feature.branch);
  const submit = confirm.getByRole('button', { name: 'Excluir worktree', exact: true });
  await submit.click();
  await expect(confirm.getByRole('alert')).toContainText('alterações locais');
  await confirm.getByRole('checkbox', { name: /Descartar/ }).check();
  await confirm.getByRole('checkbox', { name: /Excluir também a branch local/ }).check();
  await submit.click();
  await expect(confirm).toHaveCount(0);
  expect(removals.at(-1)).toMatchObject({ path: feature.path, confirmed: true, discardChanges: true, deleteBranch: true });
  await expect(picker).toContainText('Principal');
  await expect(rows.first()).toContainText('Sessão do workspace principal');
  await picker.click();
  await expect(history.getByRole('button', { name: 'feature', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
