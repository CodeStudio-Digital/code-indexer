import { expect, test } from '@playwright/test';

test('shows effective effort, prepares without sending, persists dismissal and controls a schedule', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('i18n-lang', 'pt-BR'));
  const now = Date.now(), id = '11111111-1111-4111-8111-111111111111';
  const data: any = { proposals: [{ id: 'p', sessionId: id, revision: 1, state: 'pending', title: 'Revisar contrato', prompt: 'Revisar o contrato da API', rationale: 'Verificação opcional', context: 'workspace', expiresAt: now + 100000 }], schedules: [], occurrences: [] };
  const policy: any = { revision: 0, settings: {}, policy: { presetVersion: '3', effective: { reasoning: { effort: 'high' }, parallelism: { maxAgents: 1 } }, reasons: [] }, budget: { starts: 2, active: 0, tokens: 150, costUsd: null, uncertain: 0, limits: { maxStarts: 24 } } };
  let dismissed = false, starts = 0;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    const body = method === 'POST' || method === 'PATCH' ? route.request().postDataJSON() : null;
    if (path.endsWith('/policy')) { if (body) { policy.settings.maxParallel = body.maxParallel; policy.revision++; } return route.fulfill({ json: policy }); }
    if (path.endsWith('/followups')) return route.fulfill({ json: data });
    if (path.endsWith('/prompt-suggestion/p/dismiss')) { dismissed = true; return route.fulfill({ json: { dismissed: true } }); }
    if (path.endsWith('/prompt-suggestion')) return route.fulfill({ json: { suggestion: dismissed ? null : { id: 'p', title: 'Continuar revisão', text: 'Revisar', expiresAt: now + 100000 } } });
    if (path.endsWith('/proposals/p/accept')) { data.proposals[0].state = 'accepted'; data.proposals[0].targetSessionId = id; return route.fulfill({ json: { seed: data.proposals[0].prompt, sessionId: id } }); }
    if (path.endsWith('/schedules')) { data.schedules.push({ ...body, id: 's', revision: 1, state: 'active', nextDueAt: body.at, runs: 0 }); return route.fulfill({ json: data.schedules[0] }); }
    if (path.endsWith('/schedules/s/control')) { data.schedules[0].state = body.action === 'pause' ? 'paused' : 'cancelled'; data.schedules[0].revision++; return route.fulfill({ json: data.schedules[0] }); }
    if (path.endsWith('/messages')) starts++;
    return route.fulfill({ json: [] });
  });
  await page.goto('/e2e/fixtures/ultra-v3.html');
  await expect(page.getByText(/Efetivo: 1 agentes em paralelo · esforço high/)).toBeVisible();
  await expect(page.getByText('Não informado pelo provedor')).toBeVisible();
  await page.getByRole('button', { name: 'Dispensar', exact: true }).first().click();
  await expect.poll(() => dismissed).toBe(true);
  await page.getByRole('button', { name: 'Preparar aqui', exact: true }).click();
  await expect(page.getByLabel('Rascunho')).toHaveValue('Revisar o contrato da API');
  await expect(page.getByTestId('sent')).toHaveText(''); expect(starts).toBe(0);
  await page.getByLabel('Rascunho').fill(''); await expect(page.getByText('Continuar revisão')).toHaveCount(0);
  await page.getByText('Criar agendamento', { exact: true }).first().click();
  await page.getByLabel('Tarefa ou lembrete', { exact: true }).fill('Revisar build amanhã');
  await page.getByLabel('Executar uma vez (horário deste computador)', { exact: true }).fill('2026-12-01T09:00');
  await page.getByRole('button', { name: 'Criar agendamento', exact: true }).click();
  await page.getByRole('button', { name: 'Pausar', exact: true }).click();
  await expect(page.getByText(/Pausado ·/)).toBeVisible();
  await page.getByLabel('Limite a partir da próxima execução').selectOption('2');
  await expect.poll(() => policy.settings.maxParallel).toBe(2);
  await page.screenshot({ path: '../../.tmp/ultra-v3-ui.png', fullPage: true });
  expect(starts).toBe(0); expect(errors).toEqual([]);
});
