import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  const state = { enabled: true, reviewing: false, repairing: false, archived: false };
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    if (req.method() === 'PATCH') { state.enabled = req.postDataJSON().memory_enabled; return route.fulfill({ json: { ok: true } }); }
    if (req.method() === 'POST') {
      if (path.endsWith('/evolution')) state.reviewing = true;
      if (path.endsWith('/repair')) state.repairing = true;
      return route.fulfill({ status: 202, json: { scheduled: true } });
    }
    if (req.method() === 'PUT') return route.fulfill({ json: { ok: true } });
    if (/\/api\/agent-memory\/\d+$/.test(path)) return route.fulfill({ json: {
      id: path.endsWith('/20') ? 20 : 1, name: path.endsWith('/20') ? 'Versão consolidada' : 'Receita de testes', description: '',
      content: 'Execute os testes com as dependências compatíveis.', type: 'procedure', source: 'session',
      archived_at: state.archived && !path.endsWith('/20') ? '2026-11-09' : null,
      superseded_by_id: state.archived && !path.endsWith('/20') ? 20 : null,
    } });
    if (path.endsWith('/overview')) return route.fulfill({ json: {
      enabled: state.enabled, totals: { total: 318, archived: 24 },
      usage: { liveProject: 318, liveUser: 232, recallHits: 68, recallEmpty: 37, events: { injected: 33, explicit_read: 5 } },
      evolution: { enabled: state.enabled, pending: 12, running: state.reviewing, nextAt: null, lastAt: 1794274000000,
        errorCode: null, lastResult: { reviewed: 8, merged: 2, refined: 1, retired: 1, rejected: 0 } },
    } });
    if (path.endsWith('/semantic')) return route.fulfill({ json: {
      enabled: true, remote: true, embeddingModel: 'nvidia/llama-nemotron-embed-vl-1b-v2:free', rerankerModel: 'nvidia/llama-nemotron-rerank-vl-1b-v2:free',
      project: { live: 318, indexed: 271, failed: 14, missing: 33, pending: 0, queuedMutations: 0,
        repairing: state.repairing, blocked: false, retryAt: Date.now() + 60000, errorCode: 'rate_limit' },
      user: { live: 232, indexed: 222, failed: 4, missing: 6, pending: 0, queuedMutations: 0,
        repairing: false, blocked: true, retryAt: null, errorCode: 'embedding_failed' },
    } });
    if (path.endsWith('/agent-memory')) {
      const global = path.includes('/projects/0/'), archived = url.searchParams.get('archived') === 'true';
      state.archived = archived;
      const items = [
        { id: 1, name: global ? 'Preferir respostas em português' : 'Executar testes no projeto Angular legado',
          description: '', excerpt: global ? 'Manter explicações diretas e preservar os contratos existentes.' : 'Use a versão de Node compatível com node-sass. Valide os arquivos alterados com testes unitários antes de executar o build completo.',
          type: global ? 'preference' : 'procedure', source: 'session', importance: 0.7, access_count: 17, scope: global ? 'user' : 'project', archived_reason: archived ? 'evolution:merge:20' : null },
        { id: 2, name: 'Correção de referências desatualizadas', description: '', excerpt: 'Confira o arquivo atual antes de aplicar uma receita antiga. Preservar a referência original permite detectar mudanças.', type: 'gotcha', source: 'consolidation', importance: 0.7, access_count: 3, scope: 'project' },
      ].filter(item => !url.searchParams.get('q') || item.name.toLowerCase().includes(url.searchParams.get('q')!.toLowerCase()));
      return route.fulfill({ json: { items, total: items.length, nextOffset: null, offset: 0, limit: 40, totals: { total: global ? 232 : 318, archived: 24 } } });
    }
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto('/e2e/fixtures/memory.html');
  await expect(page.getByRole('heading', { name: 'Memória e aprendizado' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Aprendizado contínuo' })).toBeVisible();
});

test('unifies stock, distinguishes usage and displays recoverable quota errors', async ({ page }) => {
  await expect(page.getByText('318 no projeto · 232 globais')).toBeVisible();
  await expect(page.getByText('Memória do agente', { exact: true })).toHaveCount(0);
  const coverage = page.getByTestId('memory-coverage-project');
  await expect(coverage).toContainText('271 / 318 · 85%');
  await expect(coverage).toContainText('33 ausentes · 14 falhas');
  await expect(coverage).toContainText(/limite|requisições/i);
  await expect(coverage.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '85');
  await page.getByText('Modelos de busca', { exact: true }).click();
  await expect(page.getByText('Embedding: nvidia/llama-nemotron-embed-vl-1b-v2:free')).toBeVisible();
});

test('switches scope and searches the selected store, including archived lineage', async ({ page }) => {
  await page.getByRole('group', { name: 'Escopo das memórias' }).getByRole('button', { name: 'Globais', exact: true }).click();
  await expect(page.getByText('Preferir respostas em português', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Buscar nas memórias' }).fill('português');
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  await expect(page.getByText('Correção de referências desatualizadas', { exact: true })).toHaveCount(0);
  await page.getByRole('combobox').selectOption('archived');
  await expect(page.getByText('Consolidada em outra memória.')).toBeVisible();
});

test('review and automatic-learning controls update the same overview without duplicate cards', async ({ page }) => {
  await page.getByRole('button', { name: 'Revisar agora' }).click();
  await expect(page.getByText('Revisando memórias', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Revisar agora' })).toBeDisabled();
  await page.getByRole('switch', { name: 'Memória automática' }).click();
  await expect(page.getByText('Revisão automática desativada')).toBeVisible();
});

test('remote repair preserves confirmation and displays progress without remounting the action', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.method() === 'POST') requests.push(request.url()); });
  await page.getByTestId('memory-coverage-project').getByRole('button').click();
  const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
  await expect(dialog).toBeVisible(); expect(requests).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Reparar cobertura' }).click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByTestId('memory-coverage-project').getByRole('button')).toBeDisabled();
});

test('fits desktop and narrow windows and renders translated controls', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.screenshot({ path: '.tmp/memory-evolution-20261109/memory-desktop.png' });
  await page.setViewportSize({ width: 420, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThan(2);
  await expect(page.getByText(/memory\.evolution\./)).toHaveCount(0);
  await page.screenshot({ path: '.tmp/memory-evolution-20261109/memory-narrow.png' });
});

test('loads a memory into the editor without overwriting edits and saves the actual draft', async ({ page }) => {
  await page.getByRole('button', { name: /Executar testes no projeto Angular legado/ }).click();
  const dialog = page.getByRole('dialog');
  const name = dialog.getByRole('textbox', { name: 'Nome', exact: true });
  await expect(name).toHaveValue('Receita de testes');
  await name.fill('Receita revisada');
  const save = page.waitForRequest(request => request.method() === 'PUT');
  await dialog.getByRole('button', { name: 'Salvar memória', exact: true }).click();
  expect((await save).postDataJSON()).toMatchObject({ name: 'Receita revisada', content: 'Execute os testes com as dependências compatíveis.' });
  await expect(dialog).toHaveCount(0);
});

test('follows archived provenance to the current version', async ({ page }) => {
  await page.getByRole('combobox').selectOption('archived');
  await page.getByRole('button', { name: /Executar testes no projeto Angular legado/ }).click();
  await page.getByRole('button', { name: 'Ver versão atual' }).click();
  await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Nome', exact: true })).toHaveValue('Versão consolidada');
});
