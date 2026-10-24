import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ json: { chapters: [], items: [], has_more: false } }));
  await page.goto('/e2e/fixtures/chat-stream.html');
  await expect(page.locator('.chat-transcript')).toBeVisible();
});

test('stream follows until upward intent, stays still while reading, and resumes explicitly', async ({ page }) => {
  const transcript = page.locator('.chat-transcript');
  await expect(transcript).toBeVisible();
  const bottomDistance = () => transcript.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
  await expect.poll(bottomDistance).toBeLessThan(10);
  await transcript.hover();
  // Tiny upward movements inside the old 8px threshold must also release follow.
  await page.mouse.wheel(0, -4);
  await expect(page.getByRole('button', { name: /latest|últim|fim|recent/i })).toBeVisible();
  const pinnedTop = await transcript.evaluate(el => el.scrollTop);
  await page.mouse.wheel(0, -500);
  await expect.poll(() => transcript.evaluate(el => el.scrollTop)).toBeLessThan(pinnedTop - 300);
  const before = await transcript.evaluate(el => el.scrollTop);
  const tick = Number(await page.locator('body').getAttribute('data-tick'));
  await expect.poll(async () => Number(await page.locator('body').getAttribute('data-tick'))).toBeGreaterThan(tick + 8);
  expect(Math.abs(await transcript.evaluate(el => el.scrollTop) - before)).toBeLessThan(3);
  await page.getByRole('button', { name: /latest|últim|fim|recent/i }).click();
  await expect.poll(bottomDistance).toBeLessThan(10);
  await page.mouse.wheel(0, -300);
  await page.evaluate(() => (window as any).chatFixture.switch());
  await expect.poll(bottomDistance).toBeLessThan(10);
});

test('tool/text blocks stay compact and 15 images open in a viewport-sized keyboard gallery', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => (window as any).chatFixture.short());
  await expect(page.getByText('Pergunta 40', { exact: true })).toHaveCount(0);
  const rows = page.locator('.chat-transcript [data-index]');
  await expect.poll(() => rows.count()).toBeGreaterThan(4);
  const gaps = await rows.evaluateAll(items => items.slice(0, -1).map((item, i) => {
    const current = item.getBoundingClientRect(); const next = items[i + 1]!.getBoundingClientRect();
    return next.top - current.bottom;
  }));
  expect(Math.max(...gaps)).toBeLessThan(12);
  await page.evaluate(() => (window as any).chatFixture.gallery());
  await expect(page.getByRole('button', { name: /Open image|Abrir imagem/ })).toHaveCount(15);
  await expect.poll(() => page.locator('.chat-transcript img').evaluateAll(images =>
    images.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await page.getByRole('button', { name: /(?:Open image|Abrir imagem) 1:/ }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(640);
  expect((await dialog.boundingBox())!.height).toBeGreaterThan(500);
  await page.keyboard.press('ArrowRight'); await expect(dialog).toContainText('Projeto 2.png');
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
  // Stored images use an explicit API origin; native <img> does not use the fetch interceptor.
  const encoded = await page.evaluate(() => (window as any).chatFixtureImage);
  await page.route('**/stored-api/api/coder/**/images/**', route => route.fulfill({ contentType: 'image/png', body: Buffer.from(encoded, 'base64') }));
  await page.evaluate(() => {
    (window as any).__MCP_API_BASE__ = `${location.origin}/stored-api`;
    (window as any).chatFixture.stored();
  });
  const firstThumbnail = page.locator('.chat-transcript img').first();
  await expect(firstThumbnail).toHaveAttribute('src', /stored-api\/api\/coder\/.*thumbnail=1/);
  await expect.poll(() => firstThumbnail.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(640);
  await page.getByRole('button', { name: /(?:Open image|Abrir imagem) 1:/ }).click();
  await expect(dialog.locator('img')).toHaveAttribute('src', /stored-api\/api\/coder\/.*\/images\/0$/);
  await expect.poll(() => dialog.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(640);
  expect(errors).toEqual([]);
});
