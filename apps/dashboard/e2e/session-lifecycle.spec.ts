import { expect, test } from '@playwright/test';
const id = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';

for (const terminal of ['done', 'error']) test(`header, sidebar and count settle on ${terminal} with hung cancel`, async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/**', route => route.fulfill({ json: { active: [{ session_id: id, bus_id: 'bus-a' }] } }));
  await page.goto('/e2e/fixtures/session-lifecycle.html');
  const count = page.getByRole('button', { name: /Mostrar.*execu|Show.*running/i });
  await expect(count).toHaveText('1');
  await page.getByRole('button', { name: 'Iniciar execução' }).click();
  await expect(page.locator('main')).toContainText('transmitindo');
  await page.evaluate(() => (window as any).lifecycle.emit('message_complete', { usage: {} }));
  await expect(count).toHaveText('1');
  await expect(page.locator('main')).toContainText('transmitindo');
  await page.evaluate(event => (window as any).lifecycle.emit(event, { reason: event === 'done' ? 'completed' : 'provider-error' }), terminal);
  await expect(count).toHaveText('0');
  await expect(page.locator('main')).not.toContainText('transmitindo');
  await expect(page.locator('aside')).not.toContainText('Em execução');
  await page.getByText('Outra conversa', { exact: true }).click();
  await expect(count).toHaveText('0');
  expect(errors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath(`terminal-${terminal}.png`) });
});

test('server activity clears stale sessions without opening each chat', async ({ page }) => {
  let active = [{ session_id: id, bus_id: 'bus-a' }, { session_id: second, bus_id: 'bus-b' }];
  let queries = 0;
  await page.clock.install();
  await page.route('**/api/**', route => { queries++; return route.fulfill({ json: { active } }); });
  await page.goto('/e2e/fixtures/session-lifecycle.html');
  const count = page.getByRole('button', { name: /Mostrar.*execu|Show.*running/i });
  await expect(count).toHaveText('2');
  active = [];
  await page.clock.fastForward(5100);
  await expect(count).toHaveText('0', { timeout: 8000 });
  await expect(page.locator('aside')).not.toContainText('Em execução');
  const settledQueries = queries;
  await page.clock.fastForward(20_000);
  expect(queries).toBe(settledQueries); // no idle polling after the last run ends
});

test('confirmed deletion clears the selected chat, attachments and draft; errors retain the other chat', async ({ page }) => {
  const requests: unknown[] = []; const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/**', async route => {
    if (route.request().url().endsWith('/batch-delete')) {
      const body = route.request().postDataJSON(); requests.push(body);
      const items = body.ids.filter((item: string) => item === id).map((session_id: string) => ({ session_id, permanent: true }));
      return route.fulfill({ json: { ok: body.ids.length === items.length, items,
        failures: body.ids.includes(second) ? [{ session_id: second, error: 'Não foi possível encerrar o worker' }] : [] } });
    }
    return route.fulfill({ json: { active: [] } });
  });
  await page.goto('/e2e/fixtures/session-lifecycle.html');
  await expect(page.getByRole('button', { name: 'Iniciar execução' })).toBeVisible();
  await page.evaluate(() => (window as any).lifecycle.stage());
  await page.getByRole('button', { name: 'Iniciar execução' }).click();
  await expect(page.locator('main')).toContainText('transmitindo');
  await page.getByRole('button', { name: 'Excluir conversa', exact: true }).click();
  await page.getByRole('button', { name: 'Apagar', exact: true }).click();
  await expect(page.getByTestId('no-chat')).toBeVisible();
  await expect(page.getByText('Conversa de teste', { exact: true })).toHaveCount(0);
  expect(requests).toEqual([{ ids: [id], permanent: true }]);
  expect(await page.evaluate(() => (window as any).lifecycle.getDraft())).toEqual({ text: '', attachments: [] });
  expect(await page.evaluate(id => localStorage.getItem('composerDraft:coder:' + id), id)).toBeNull();
  await page.getByText('Outra conversa', { exact: true }).click();
  await page.getByRole('button', { name: 'Excluir todas', exact: true }).click();
  await page.getByRole('button', { name: 'Apagar', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Não foi possível encerrar o worker');
  await expect(page.locator('aside').getByText('Outra conversa', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
