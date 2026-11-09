import { test, expect } from '@playwright/test';
import { collaborationData, collaborationPolicy } from '../fixtures/collaboration-data.js';
test('links chats, shows correlated exchanges, pauses requests and keeps reasoning selectable in Ultra', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  let linked = false, stopped = false;
  await page.route('**/api/coder/sessions/one/collaboration**', async route => {
    const request = route.request();
    if (request.method() === 'PUT') linked = request.postDataJSON().enabled;
    if (request.method() === 'POST') stopped = request.url().endsWith('/stop');
    if (new URL(request.url()).pathname.endsWith('/policy')) return route.fulfill({ json: collaborationPolicy() });
    const data = { ...collaborationData('one'), stopped, peers: linked ? [{ id:'chat:two', sessionId:'two', label:'Revisão de API', profile:'review', state:'idle' }] : [],
      candidates:[{id:'two',title:'Revisão de API'}], links: linked ? [{ sessions: ['one', 'two'], enabled: true }] : [],
      messages: linked ? [{id:'message',from:'chat:one',to:'chat:two',kind:'question',body:'Confirme o contrato da API antes da integração.',status:'answered',references:['src/contracts.ts']}] : [] };
    await route.fulfill({ json: data });
  });
  await page.goto('/e2e/fixtures/ultra-collaboration.html');
  await page.getByLabel('Selecionar chat').selectOption('two');
  await page.getByRole('button',{name:'Vincular',exact:true}).click();
  await expect(page.getByRole('button',{name:'Desvincular',exact:true})).toBeVisible();
  await page.getByRole('tab', { name: 'Mensagens', exact: true }).click();
  await page.locator('summary').click();
  await expect(page.getByText('Confirme o contrato da API antes da integração.')).toBeVisible();
  await expect(page.getByText('src/contracts.ts')).toBeVisible();
  await page.screenshot({path:test.info().outputPath('ultra-collaboration.png')});
  await page.getByRole('tab', { name: 'Grafo', exact: true }).click();
  await page.getByRole('button',{name:'Pausar solicitações automáticas'}).click();
  await expect(page.getByRole('button',{name:'Retomar solicitações automáticas'})).toBeVisible();
  await page.getByRole('button',{name:'Retomar solicitações automáticas'}).click();
  await page.getByRole('button',{name:'Desvincular',exact:true}).click();
  await expect(page.getByLabel('Selecionar chat').locator('option[value="two"]')).toHaveCount(1);
  await page.getByRole('button',{name:'Configurar modelo'}).click();
  await expect(page.getByRole('switch',{name:'Modo Ultra'})).toBeChecked();
  const effort = page.getByRole('dialog').locator('select').filter({has:page.locator('option[value="high"]')});
  await expect(effort).toBeEnabled(); await effort.selectOption('low');
  await page.keyboard.press('Escape'); await expect(page.getByTestId('effort')).toHaveText('low');
  expect(errors).toEqual([]);
});

test('recovers from malformed network and policy responses without losing the panel', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  let validNetwork = false, validPolicy = false;
  await page.route('**/api/coder/sessions/one/collaboration**', route => route.fulfill({ json:
    new URL(route.request().url()).pathname.endsWith('/policy')
      ? validPolicy ? collaborationPolicy() : []
      : validNetwork ? collaborationData('one') : { self: 'chat:one', peers: [], messages: [] } }));
  await page.goto('/e2e/fixtures/ultra-collaboration.html');
  await expect(page.getByRole('alert')).toContainText('A resposta recebida é inválida');
  validNetwork = true;
  await page.getByRole('button', { name: 'Tentar novamente', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Grafo de colaboração' })).toBeVisible();
  await page.getByRole('tab', { name: 'Equipe', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('A resposta recebida é inválida');
  validPolicy = true;
  await page.getByRole('button', { name: 'Tentar novamente', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('Ultra v3', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('creates and links chats, edits policy, pauses and resumes through real local routes', async ({ page, request }) => {
  test.skip(!process.env.CODESTUDIO_E2E_API_URL, 'Requires the isolated collaboration backend fixture');
  const api = process.env.CODESTUDIO_E2E_API_URL!;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const seed = await request.post(`${api}/__fixture/network`);
  expect(seed.ok()).toBe(true);
  const { sessionId, peerId } = await seed.json();
  const path = `${api}/api/coder/sessions/${sessionId}/collaboration`;
  await page.goto(`/e2e/fixtures/ultra-collaboration.html?sessionId=${sessionId}`);
  await page.getByLabel('Selecionar chat').selectOption(peerId);
  await page.getByRole('button', { name: 'Vincular', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Desvincular', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Equipe', exact: true }).click();
  await page.getByText('Ultra v3', { exact: true }).locator('..').locator('select').first().selectOption('2');
  await expect.poll(async () => (await (await request.get(`${path}/policy`)).json()).settings.maxParallel).toBe(2);
  await page.getByRole('checkbox', { name: 'Agêntico', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Agêntico', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Adicionar participante', exact: true }).click();
  await page.getByLabel('Nome do participante 1', { exact: true }).fill('Revisor local');
  await page.getByLabel('Função do participante 1', { exact: true }).fill('Verificar contratos sem iniciar um modelo.');
  await page.getByRole('button', { name: 'Criar sessões preparadas', exact: true }).click();
  await expect(page.getByLabel('Nome do participante 1', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Grafo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Revisor local', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pausar solicitações automáticas', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retomar solicitações automáticas', exact: true })).toBeVisible();
  expect((await (await request.get(path)).json()).stopped).toBe(true);
  await page.getByRole('button', { name: 'Retomar solicitações automáticas', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pausar solicitações automáticas', exact: true })).toBeVisible();
  const snapshot = await (await request.get(path)).json();
  expect(snapshot.stopped).toBe(false);
  expect(snapshot.chats).toHaveLength(3);
  expect(snapshot.messages).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('real-network.png') });
  expect(errors).toEqual([]);
});
