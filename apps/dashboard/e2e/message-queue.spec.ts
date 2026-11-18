import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ json: { items: [], skills: [], suggestions: [] } }));
  await page.goto('/e2e/fixtures/message-queue.html');
  await expect(page.locator('textarea')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
});

const queueButton = /^(Queue|Enfileirar)$/;
const sendButton = /^(Send now|Enviar agora)$/;
const entries = (page: import('@playwright/test').Page) => page.locator('[data-queue-status]');

test('accepted steering remains visible until consumed and cannot be cancelled as if unsent', async ({ page }) => {
  await page.evaluate(() => { (window as any).queueFixture.acceptedId = 42; });
  await page.locator('textarea').fill('new guidance'); await page.getByRole('button', { name: sendButton }).click();
  await expect(page.locator('[data-queue-status="accepted"]')).toHaveCount(1);
  await expect(entries(page).getByRole('button', { name: sendButton })).toBeDisabled();
  await expect(entries(page).getByRole('button', { name: /^(Remove|Remover)$/ })).toBeDisabled();
  await page.evaluate(() => (window as any).queueFixture.consume(42));
  await expect(entries(page)).toHaveCount(0);
});

test('queue waits and drains one task per run; individual promotion keeps the others parked', async ({ page }) => {
  for (const text of ['one', 'two', 'three']) {
    await page.locator('textarea').fill(text); await page.getByRole('button', { name: queueButton }).click();
  }
  await expect(entries(page)).toHaveCount(3);
  expect(await page.evaluate(() => (window as any).queueFixture.deliveries)).toHaveLength(0);
  await entries(page).nth(1).getByRole('button', { name: sendButton }).click();
  await expect(entries(page)).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).queueFixture.deliveries.map((item: any) => item.text))).toEqual(['two']);
  await page.evaluate(() => (window as any).queueFixture.finish());
  await expect(entries(page)).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).queueFixture.deliveries.map((item: any) => item.text))).toEqual(['two', 'one']);
  await page.evaluate(() => (window as any).queueFixture.finish());
  await expect(entries(page)).toHaveCount(0);
});

test('send-now and queue keyboard shortcuts have distinct behavior and retain pending acknowledgements', async ({ page }) => {
  await page.evaluate(() => { (window as any).queueFixture.hold = true; });
  await page.locator('textarea').fill('steer'); await page.locator('textarea').press('Control+Enter');
  await expect(page.locator('[data-queue-status="sending"]')).toHaveCount(1);
  await page.locator('textarea').fill('later'); await page.locator('textarea').press('Control+Shift+Enter');
  await expect(entries(page)).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).queueFixture.deliveries.map((item: any) => item.text))).toEqual(['steer']);
  await page.evaluate(() => (window as any).queueFixture.ack());
  await expect(entries(page)).toHaveCount(1);
  await expect(entries(page)).toContainText('later');
});

test('navigation preserves queues and delivers to their original conversation while hidden', async ({ page }) => {
  await page.locator('textarea').fill('task A'); await page.getByRole('button', { name: queueButton }).click();
  await page.evaluate(() => (window as any).queueFixture.switch('queue-b'));
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(entries(page)).toHaveCount(0);
  await page.locator('textarea').fill('task B'); await page.getByRole('button', { name: queueButton }).click();
  await page.evaluate(() => (window as any).queueFixture.finish('queue-a'));
  await expect.poll(() => page.evaluate(() => (window as any).queueFixture.deliveries.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).queueFixture.deliveries[0].sessionId)).toBe('queue-a');
  await expect(entries(page)).toContainText('task B');
  await page.evaluate(() => (window as any).queueFixture.switch('queue-a'));
  await expect(entries(page)).toHaveCount(0);
});

test('reload retains attachment payloads and waits for explicit queue resume', async ({ page }) => {
  await page.evaluate(() => (window as any).queueFixture.attach([{ name: 'notes.txt', mediaType: 'text/plain', text: 'important notes' }]));
  await page.locator('textarea').fill('with attachment'); await page.getByRole('button', { name: queueButton }).click();
  await expect(entries(page)).toHaveCount(1);
  // Wait for the IndexedDB transaction before simulating a process reload.
  await expect.poll(() => page.evaluate(async () => {
    const modulePath = '/features/chat/composer/message-queue-storage.ts';
    const { loadQueuedMessages } = await import(modulePath);
    return (await loadQueuedMessages('queue-a')).length;
  })).toBe(1);
  await page.reload();
  await expect(entries(page)).toHaveCount(1);
  await expect(page.getByRole('button', { name: /^(Resume queue|Retomar fila)$/ })).toBeVisible();
  await page.evaluate(() => (window as any).queueFixture.finish());
  expect(await page.evaluate(() => (window as any).queueFixture.deliveries.length)).toBe(0);
  await page.getByRole('button', { name: /^(Resume queue|Retomar fila)$/ }).click();
  await expect(entries(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).queueFixture.deliveries[0].attachments[0].text)).toBe('important notes');
});

test('failure is visible and retry keeps the same command ID', async ({ page }) => {
  await page.evaluate(() => { (window as any).queueFixture.fail = true; });
  await page.locator('textarea').fill('keep this'); await page.getByRole('button', { name: sendButton }).click();
  await expect(page.getByRole('alert')).toContainText('Connection lost');
  await expect(entries(page)).toHaveCount(1);
  await page.getByRole('button', { name: /^(Retry|Tentar novamente)$/ }).click();
  await expect(entries(page)).toHaveCount(0);
  const ids = await page.evaluate(() => (window as any).queueFixture.deliveries.map((item: any) => item.clientMessageId));
  expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]);
});

test('stop pauses parked tasks and the composer fits narrow windows', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 800 });
  await page.locator('textarea').fill('queued task'); await page.getByRole('button', { name: queueButton }).click();
  await page.getByRole('button', { name: /^(Stop|Parar)$/ }).click();
  await expect(entries(page)).toHaveCount(1);
  await expect(page.getByRole('button', { name: /^(Resume queue|Retomar fila)$/ })).toBeVisible();
  expect(await page.evaluate(() => (window as any).queueFixture.deliveries.length)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThan(2);
});
