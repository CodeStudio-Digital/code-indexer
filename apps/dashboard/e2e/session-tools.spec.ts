import { expect, test, type Page } from '@playwright/test';

const sessionId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
async function setup(page: Page, legacy = 'meta', history = false) {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ legacy }) => {
    localStorage.setItem('i18n-lang', 'pt-BR');
    localStorage.setItem('chatRightPanelId', legacy);
  }, { legacy });
  const session = (id: string) => ({ id, title: id === sessionId ? 'Reorganizar ferramentas da sessão' : 'Segunda sessão', project_id: 7,
    worktree_path: null, provider: 'openai', model: 'gpt-test', status: 'idle', created_at: '2026-10-24T12:00:00Z', updated_at: '2026-10-24T12:00:00Z',
    group_id: null, is_archived: false, is_favorite: false, total_input_tokens: 0, total_output_tokens: 0, total_cache_read_tokens: 0,
    total_cache_creation_tokens: 0, last_turn_input_tokens: 0, agent: 'code' });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()); const path = url.pathname; requests.push(path + url.search);
    if (path.endsWith('/db-client/connections')) return route.fulfill({ json: { connections: [] } });
    if (path.includes('/skills')) return route.fulfill({ json: { skills: [{ id: 'review', name: 'Revisar código', description: 'Verificar mudanças', enabled: true, session_enabled: true, is_active: false, source: 'user', tags: [] }], active_count: 1 } });
    if (path.endsWith('/attachments')) return route.fulfill({ json: { items: [], total: 0, next_offset: null } });
    if (path.endsWith('/tree')) return route.fulfill({ json: { mode: 'tree', entries: [{ name: 'app.ts', path: 'src/app.ts', type: 'file', size: 50 }], files: ['src/app.ts'] } });
    if (path.endsWith('/state-summary')) return route.fulfill({ json: { goal: null, tasks: null, todos: path.includes(secondId) ? [] : [
      { id: 'done', content: 'Preparar navegação', status: 'completed' }, { id: 'now', content: 'Validar fluxos', activeForm: 'Validando fluxos', status: 'in_progress' }] } });
    if (path.endsWith('/plans')) return route.fulfill({ json: [{ id: 'plan1', session_id: sessionId, plan_text: 'Plano de reorganização\n\nPreservar as ferramentas úteis.', status: 'approved', feedback: 'Proteções preservadas', created_at: '2026-10-24T12:00:00Z', resolved_at: null }] });
    if (path.endsWith('/drive')) return route.fulfill({ json: { fileMap: { read: ['README.md'], changed: ['src/app.ts'] }, memory: [{ id: 'note1', kind: 'note', title: 'Decisão da interface', body: 'Preservar recursos avançados.', pinned: false, updated_at: '2026-10-24T12:00:00Z' }], investigations: [{ id: 'inv1', topic: 'Investigar ferramentas', summary: 'Ferramentas disponíveis', body: 'Todas preservadas.', source_label: 'Revisor', agent_type: 'investigator', tokens: 100, created_at: '2026-10-24T12:00:00Z' }], plans: [], tasks: null } });
    if (path.endsWith('/chapters')) return route.fulfill({ json: { items: [], next_cursor: null, status: { state: 'empty', chapter_count: 0, unsummarized_messages: 0, boundary_seq: 0, counters: { summarized: 0, deterministic_fallbacks: 0 } } } });
    if (path === '/api/coder/worktrees') return route.fulfill({ json: { projectId: 7, isGit: true, worktrees: [{ path: 'D:/fixture/project', branch: 'main', primary: true, locked: false, prunable: false }] } });
    if (path === '/api/coder/sessions') return route.fulfill({ json: [session(sessionId), session(secondId)] });
    const id = path.match(/^\/api\/coder\/sessions\/([^/]+)$/)?.[1];
    if (id) return route.fulfill({ json: { session: session(id), messages: history && id === sessionId ? [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'spawn-1', name: 'spawn_agent', input: { agents: [{ label: 'Revisor', task: 'Verificar interface', type: 'investigator' }] } }] },
      { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'spawn-1', content: '[subagent provider=chatgpt model=gpt-5 type=investigator reason=completed input=10 output=5]\n\nInterface verificada.' }] },
    ] : [], message_rows: [], linked_projects: [] } });
    if (path.endsWith('/status')) return route.fulfill({ json: { active: false } });
    if (path === '/api/coder/providers') return route.fulfill({ json: { providers: [], legacy: true } });
    if (path.includes('/snapshot')) return route.fulfill({ json: { files: [], reviews: [], runs: [], comments: [] } });
    if (path.endsWith('/stats')) return route.fulfill({ json: {} });
    if (path.endsWith('/state')) return route.fulfill({ json: { todos: [], tasks: [], state: null } });
    return route.fulfill({ json: [] });
  });
  await page.goto('/e2e/fixtures/session-worktrees.html');
  await page.locator(`[data-session-id="${sessionId}"]`).click();
  const rail = page.getByRole('navigation', { name: 'Ferramentas da sessão' });
  await expect(rail).toBeVisible();
  return { rail, errors, requests };
}

test('State and Context preserve progress, plans, attachments and durable context', async ({ page }) => {
  const { rail, errors, requests } = await setup(page);
  await expect(rail.getByRole('button')).toHaveCount(6);
  await expect(rail.getByRole('button', { name: 'Estado', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Validando fluxos', { exact: true })).toBeVisible();
  await expect(page.getByText('Preparar navegação', { exact: true })).not.toBeVisible();
  await page.locator('summary', { hasText: 'Concluídas (1)' }).click();
  await expect(page.getByText('Preparar navegação', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Planos', exact: true }).click();
  await page.getByRole('button', { name: /Plano de reorganização/ }).click();
  await expect(page.getByText('Preservar as ferramentas úteis.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copiar markdown', exact: true })).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: `.tmp/session-rail-20261024/state-${test.info().project.name}.png` });
  await rail.getByRole('button', { name: 'Contexto', exact: true }).click();
  await page.getByRole('button', { name: 'Arquivos do projeto', exact: true }).click();
  const file = page.getByRole('treeitem', { name: 'app.ts', exact: true });
  await file.click(); await expect(file).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Skills', exact: true })).toHaveCount(0);
  expect(requests.some(path => path.includes('/tree?') && path.includes(`session_id=${sessionId}`))).toBe(true);
  await page.screenshot({ animations: 'disabled', path: `.tmp/session-rail-20261024/context-${test.info().project.name}.png` });
  await page.getByRole('tab', { name: 'Mapa', exact: true }).click();
  await expect(page.getByText('README.md', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Notas', exact: true }).click();
  await page.getByText('Decisão da interface', { exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Preservar recursos avançados.');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Investigações', exact: true }).click();
  await expect(page.getByText('Investigar ferramentas', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Capítulos', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Planos', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Anexos', exact: true }).click();
  await expect(file).toHaveAttribute('aria-selected', 'true');
  await page.locator(`[data-session-id="${secondId}"]`).click();
  await rail.getByRole('button', { name: 'Estado', exact: true }).click();
  await expect(page.getByText('Validando fluxos', { exact: true })).not.toBeVisible();
  await expect(page.getByText(/Nenhum objetivo ou tarefa ainda/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('More supports keyboard, notifications retain errors, changes and configuration stay reachable', async ({ page }) => {
  const { rail, errors } = await setup(page, 'chapters', true);
  await expect(rail.getByRole('button', { name: 'Contexto', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('tab', { name: 'Capítulos', exact: true })).toHaveAttribute('data-state', 'active');
  const more = rail.getByRole('button', { name: 'Mais', exact: true });
  await more.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Subagentes/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Diagrama/ })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(more).toBeFocused();
  await rail.getByRole('button', { name: 'Subagentes', exact: true }).click();
  await expect(page.getByText('Interface verificada.', { exact: true }).last()).toBeVisible();
  await more.click(); await page.screenshot({ animations: 'disabled', path: `.tmp/session-rail-20261024/more-${test.info().project.name}.png` });
  await page.getByRole('menuitem', { name: 'Análise da sessão' }).click();
  await expect(page.getByRole('tab', { name: 'Resumo' })).toBeVisible();
  await page.evaluate(async (id) => {
    // Exercise the real store, including unread/read transitions.
    const modulePath = '/features/chat/notifications/session-notifications-store.ts';
    const store = await import(modulePath);
    store.pushNotification(id, { kind: 'run-error', message: 'Falha preservada para diagnóstico' });
  }, sessionId);
  const bell = page.getByRole('button', { name: /Notificações: 1 não lida/ });
  await expect(bell).toBeVisible(); await bell.click();
  await expect(page.getByRole('button', { name: 'Notificações', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Dispensar ativas', exact: true }).click();
  await expect(page.getByText('Falha preservada para diagnóstico', { exact: true })).toBeVisible();
  await rail.getByRole('button', { name: 'Alterações', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape');
  await rail.getByRole('button', { name: 'Configurações', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Habilidades', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Ferramentas', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('More preserves project integrations and preview; subagent shortcut follows the selected session', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('i18n-lang', 'pt-BR'));
  await page.goto('/e2e/fixtures/session-rail.html');
  const rail = page.getByRole('navigation', { name: 'Ferramentas da sessão' });
  await expect(rail.getByRole('button')).toHaveCount(6);
  await rail.getByRole('button', { name: 'Mais', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /Preview/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Somente esquerda' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Cloudflare', exact: true }).click();
  await expect(page.getByTestId('selected')).toHaveText('plugin:cloudflare:cf-manage');
  await page.getByRole('button', { name: 'Alternar preview' }).click();
  await rail.getByRole('button', { name: 'Mais', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /Preview/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Simular subagentes' }).click();
  await expect(rail.getByRole('button', { name: 'Subagentes: 2 em execução' })).toBeVisible();
  await page.getByRole('button', { name: 'Trocar sessão' }).click();
  await expect(rail.getByRole('button')).toHaveCount(6);
  await rail.getByRole('button', { name: 'Alterações: 27 trechos pendentes', exact: true }).click();
  await expect(page.getByTestId('selected')).toHaveText('changes');
});
