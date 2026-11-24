import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesignTestHost } from '../../http-api/server/routes/company/__tests__/designer-fixture.js';
import { newRole } from '@mcp/company-contracts/designer.js';

test('sends an ordinary chat while its optional Clef request is still pending', async ({ page }) => {
  let sendCount = 0,
    switchCount = 0;
  let allowDecision!: () => void;
  const pending = new Promise<void>((done) => {
    allowDecision = done;
  });
  let evaluating = false;
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/suggest')) {
        evaluating = true;
        await pending;
        return route.fulfill({ json: { candidate: null, reason: 'timeout' } });
      }
      if (path.startsWith('/api/decisions/chat/'))
        return route.fulfill({
          json: { enabled: true, own: 'suggest', effective: 'suggest', origin: 'session' },
        });
      if (path.endsWith('/messages')) {
        sendCount++;
        return route.fulfill({
          contentType: 'text/event-stream',
          body: 'event: text\ndata: {"text":"Resposta sintética"}\n\nevent: done\ndata: {"reason":"complete"}\n\n',
        });
      }
      if (path.endsWith('/switch')) switchCount++;
      return route.fulfill({ json: [] });
    },
  );
  try {
    await page.goto('/e2e/fixtures/provider-selection.html');
    await page.locator('textarea').fill('Investigue os testes de exemplo.');
    await page.locator('summary').filter({ hasText: 'Decisões com Clef' }).click();
    await page.getByRole('button', { name: 'Sugerir perfil' }).click();
    await expect.poll(() => evaluating).toBe(true);
    await page.getByRole('button', { name: /Enviar/ }).click();
    await expect.poll(() => sendCount).toBe(1);
    await expect(page.getByTestId('agent-answer')).toHaveText('Resposta sintética');
    await expect(page.getByTestId('selection')).toHaveText('openai-api · gpt-test');
    expect(switchCount).toBe(0);
  } finally {
    allowDecision();
  }
});

test('measures first displayed text with optional decisions off and stalled', async ({ context }, info) => {
  const arms = await Promise.all(
    ([false, true] as const).map(async (enabled) => {
      const page = await context.newPage();
      let requests = 0;
      let sends = 0;
      const pending: Array<() => void> = [];
      await page.route(
        (url) => url.pathname.startsWith('/api/'),
        async (route) => {
          const path = new URL(route.request().url()).pathname;
          if (path.endsWith('/suggest')) {
            requests++;
            await new Promise<void>((done) => pending.push(done));
            return route.fulfill({ json: { candidate: null, reason: 'timeout' } }).catch(() => {});
          }
          if (path.startsWith('/api/decisions/chat/'))
            return route.fulfill({
              json: {
                enabled,
                own: enabled ? 'shadow' : 'off',
                effective: enabled ? 'shadow' : 'off',
                origin: 'session',
              },
            });
          if (path.endsWith('/messages')) {
            const data = JSON.stringify({ text: 'Resposta ' + ++sends });
            return route.fulfill({
              contentType: 'text/event-stream',
              body: 'event: text\n' + 'data: ' + data + '\n\nevent: done\ndata: {}\n\n',
            });
          }
          return route.fulfill({ json: [] });
        },
      );
      await page.goto('/e2e/fixtures/provider-selection.html');
      await expect(page.locator('textarea')).toBeVisible();
      if (enabled) await expect(page.getByText('Decisões com Clef', { exact: true })).toBeVisible();
      const times: number[] = [];
      return { page, pending, times, count: () => requests };
    }),
  );
  try {
    // Alternate A/B and B/A. Start the timer on the real send click inside Chromium.
    for (let round = 0; round < 22; round++) {
      const order = round % 2 ? [1, 0] : [0, 1];
      for (const index of order) {
        const { page, times, pending } = arms[index];
        const text = 'Resposta ' + (round + 1);
        await page.locator('textarea').fill('Exemplo ' + round);
        const button = page.getByRole('button', { name: /Enviar/ });
        await button.evaluate((node, expected) => {
          const output = document.querySelector<HTMLElement>('[data-testid=agent-answer]')!;
          delete output.dataset.firstTextMs;
          node.addEventListener(
            'click',
            () => {
              const start = performance.now();
              const observer = new MutationObserver(() => {
                if (output.textContent !== expected) return;
                output.dataset.firstTextMs = String(performance.now() - start);
                observer.disconnect();
              });
              observer.observe(output, { childList: true, subtree: true, characterData: true });
            },
            { once: true, capture: true },
          );
        }, text);
        await button.click();
        const output = page.getByTestId('agent-answer');
        await expect(output).toHaveText(text);
        const ms = Number(await output.getAttribute('data-first-text-ms'));
        expect(ms).toBeGreaterThan(0);
        if (round >= 2) times.push(ms);
        for (const done of pending.splice(0)) done();
      }
    }
    expect(arms[0].count()).toBe(0);
    expect(arms[1].count()).toBeGreaterThan(0);
    const percentiles = arms.map((a) => {
      const t = [...a.times].sort((x, y) => x - y);
      return {
        samples: t.length,
        p50Ms: t[Math.ceil(t.length * 0.5) - 1],
        p95Ms: t[Math.ceil(t.length * 0.95) - 1],
      };
    });
    const report = {
      size: info.project.name,
      off: percentiles[0],
      stalledShadow: percentiles[1],
      p95DeltaMs: percentiles[1].p95Ms - percentiles[0].p95Ms,
    };
    await info.attach('first-text-latency', {
      body: JSON.stringify(report),
      contentType: 'application/json',
    });
    console.log('FIRST_TEXT ' + JSON.stringify(report));
  } finally {
    for (const arm of arms) {
      for (const done of arm.pending.splice(0)) done();
      await arm.page.close();
    }
  }
});

test('keeps past QA reports reachable and opens the active run from visual companies', async ({ page }) => {
  const legacy = {
    id: 'legacy-run',
    suite: 'Conferência de contratos',
    executor: 'playwright',
    started_at: '2026-05-01T10:00:00Z',
    passed: 1,
    failed: 0,
    skipped: 0,
    status: 'completed',
    duration_ms: 400,
    trigger: 'human',
  };
  const active = { ...legacy, id: 'active-run', status: 'running', suite: 'Revisão do formulário' };
  const report = '/api/company/sessions/qa-company/qa/reports/legacy-run/index.html';

  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/runs/legacy-run'))
        return route.fulfill({ json: { run: legacy, results: [], report_url: report } });
      if (path.endsWith('/runs/active')) return route.fulfill({ json: { run: active, results: [] } });
      if (path.endsWith('/qa/runs')) return route.fulfill({ json: { runs: [legacy] } });
      if (path.endsWith('/services')) return route.fulfill({ json: { services: [] } });
      if (path.endsWith('/task-options')) return route.fulfill({ json: { projects: [], roles: [] } });
      return route.fulfill({ json: [] });
    },
  );

  const preview = page.getByRole('navigation').getByRole('button', { name: 'Preview e QA' });
  await page.goto('/e2e/fixtures/company-designer.html?qa');
  await expect(page.getByRole('button', { name: 'Histórico de validações' })).toBeVisible();
  await expect(preview).toHaveCount(0);
  await page.getByRole('button', { name: 'Histórico de validações' }).click();
  await expect(page.getByRole('tab', { name: 'Histórico' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('row', { name: /Conferência de contratos/ }).click();
  await expect(page.locator('a[href="' + report + '"]')).toBeVisible();

  await page.goto('/e2e/fixtures/company-designer.html?qa&visual');
  await preview.click();
  await expect(page.getByText('Revisão do formulário', { exact: true })).toBeVisible();
  await page.goto('/e2e/fixtures/company-designer.html?qa&direct');
  await expect(page.getByText('Revisão do formulário', { exact: true })).toBeVisible();
});

test('creates and reopens a reviewed company from the agent center', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'company-designer-browser-'));
  try {
    const reviewer = {
      ...newRole('reviewer', 'chatgpt', 'sol'),
      effort: 'max',
      projectIds: [1, 2],
      skills: ['contract'],
      readOnly: true,
    };
    const host = await createDesignTestHost(root, {
      reply: 'Incluí um revisor para confrontar os contratos.',
      changes: {
        name: 'Auditoria',
        projectIds: [1, 2],
        roles: [newRole('master', 'chatgpt', 'sol'), reviewer],
        tasks: [
          {
            id: 'compare',
            title: 'Confrontar os contratos',
            description: 'Comparação sintética',
            owner: 'reviewer',
            projectId: 1,
            dependsOn: [],
            criteria: ['Fonte verificada'],
          },
        ],
      },
    });
    const app = host.router();
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      async (route) => {
        const req = route.request(),
          url = new URL(req.url());
        const res = await app.request(url.pathname + url.search, {
          method: req.method(),
          headers: { 'content-type': 'application/json' },
          body: req.postData() ?? undefined,
        });
        await route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
      },
    );
    await page.goto('/e2e/fixtures/company-designer.html');
    const open = page.getByRole('button', { name: 'Criar com IA', exact: true });
    await open.click();
    await page.getByRole('button', { name: 'Começar rascunho' }).click();
    await page.getByLabel('Nome da empresa').fill('Contratos de teste');
    await page.getByLabel('O que você quer montar ou mudar?').fill('Dois projetos, um revisor no ChatGPT.');
    await page.getByRole('button', { name: 'Pedir proposta' }).click();
    await page.getByRole('button', { name: 'Aceitar seleção' }).click();
    await expect(page.getByLabel('Nome da empresa')).toHaveValue('Contratos de teste');
    await page.getByRole('button', { name: 'Equipe', exact: true }).click();
    await expect(
      page
        .locator('fieldset')
        .filter({ has: page.locator('legend', { hasText: 'reviewer' }) })
        .last()
        .getByLabel('Esforço'),
    ).toHaveValue('max');
    const role = page
      .locator('fieldset')
      .filter({ has: page.locator('legend', { hasText: 'reviewer' }) })
      .last();
    await role.getByLabel('Provedor').selectOption('bedrock');
    await role.getByLabel('Provedor').selectOption('chatgpt');
    await role.getByLabel('Esforço').selectOption('max');
    // The next synthetic suggestion contradicts the manual provider choice.
    reviewer.provider = 'bedrock';
    reviewer.effort = '';
    reviewer.responsibility = 'Revisar as cláusulas divergentes';
    await page.getByLabel('O que você quer montar ou mudar?').fill('Ajuste a responsabilidade do revisor.');
    await page.getByRole('button', { name: 'Pedir proposta' }).click();
    await page.getByRole('button', { name: 'Aceitar seleção' }).click();
    await expect(role.getByLabel('Provedor')).toHaveValue('chatgpt');
    await expect(role.getByLabel('Esforço')).toHaveValue('max');
    await expect(role.getByLabel('Responsabilidade')).toHaveValue(reviewer.responsibility);
    await page.getByRole('button', { name: 'Salvar e fechar' }).click();
    await open.click();
    await page.getByRole('button', { name: /Retomar.*Contratos de teste/ }).click();
    await page.getByRole('button', { name: 'Revisar configuração' }).click();
    await expect(page.getByText('Confrontar os contratos → reviewer', { exact: false })).toBeVisible();
    expect(await host.sessions.listCompanySessions()).toHaveLength(0);
    await page.getByRole('button', { name: 'Criar empresa', exact: true }).click();
    const location = page.locator('output');
    await expect(location).toContainText('/company/sessions/');
    const companies = await host.sessions.listCompanySessions();
    expect(companies).toHaveLength(1);
    await expect(location).toContainText(companies[0].id);
    const full = await host.sessions.getCompanySessionFull(companies[0].id);
    expect(full?.session.name).toBe('Contratos de teste');
    expect(full?.agentRuns).toEqual([]);
    expect(JSON.parse(full!.session.config_json).role_assignments).toContainEqual(
      expect.objectContaining({
        role: 'reviewer',
        provider: 'chatgpt',
        model: 'sol',
        reasoningEffort: 'max',
      }),
    );
    const cards = await (await app.request('/api/company/sessions/' + companies[0].id + '/kanban')).json();
    expect(cards).toMatchObject([
      { title: 'Confrontar os contratos', control: { owner: 'reviewer', projectId: 1 } },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
