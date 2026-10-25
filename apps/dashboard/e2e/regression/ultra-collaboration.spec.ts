import { test, expect } from '@playwright/test';
test('links chats, shows correlated exchanges, pauses requests and keeps reasoning selectable in Ultra', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  let linked = false, stopped = false;
  await page.route('**/api/coder/sessions/one/collaboration**', async route => {
    const request = route.request();
    if (request.method() === 'PUT') linked = request.postDataJSON().enabled;
    if (request.method() === 'POST') stopped = request.url().endsWith('/stop');
    const data = { self: 'chat:one', stopped, peers: linked ? [{ id:'chat:two', sessionId:'two', label:'Revisão de API', state:'idle' }] : [],
      candidates:[{id:'two',title:'Revisão de API'}], policy:{effective:{reasoning:{effort:'high'},parallelism:{maxAgents:3}}},
      messages: linked ? [{id:'message',from:'chat:one',to:'chat:two',kind:'question',body:'Confirme o contrato da API antes da integração.',status:'answered',references:['src/contracts.ts']}] : [] };
    await route.fulfill({ json: data });
  });
  await page.goto('/e2e/fixtures/ultra-collaboration.html');
  await page.getByLabel('Selecionar chat').selectOption('two');
  await page.getByRole('button',{name:'Vincular',exact:true}).click();
  await expect(page.getByRole('button',{name:'Desvincular',exact:true})).toBeVisible();
  await page.locator('summary').click();
  await expect(page.getByText('Confirme o contrato da API antes da integração.')).toBeVisible();
  await expect(page.getByText('src/contracts.ts')).toBeVisible();
  await page.screenshot({path:'../../.tmp/ultra-collaboration.png'});
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
