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
  // wheel() returns before Chromium applies the scroll. Consume the old
  // session's gesture before testing the new session's follow reset.
  await expect.poll(bottomDistance).toBeGreaterThan(100);
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

test('long user messages keep a readable width with or without attachments after Markdown is virtualized', async ({ page }) => {
  const paragraphs = Array.from({ length: 120 }, (_, i) =>
    `Passo ${i + 1}: revisar o contrato de execução e os campos do tratamento. O conteúdo deve continuar legível e a imagem deve permanecer anexada à mensagem.`);
  const text = 'No histórico de execução agora tem nome do passo e nome do tratamento.\n\n' + paragraphs.join('\n\n');
  for (const width of [1440, 850, 420]) {
    await page.setViewportSize({ width, height: 900 });
    for (const imageCount of [0, 1, 3]) {
      await page.evaluate(args => (window as any).chatFixture.layout(args), { text, imageCount });
      const document = page.locator('[data-large-markdown]');
      await expect(document).toHaveAttribute('data-markdown-ready', 'true');
      await expect(page.locator('.chat-transcript img')).toHaveCount(imageCount);
      await expect.poll(() => document.evaluate(node => {
        const article = node.closest('article')!;
        return article.getBoundingClientRect().width / article.parentElement!.getBoundingClientRect().width;
      })).toBeGreaterThan(0.75);
      const viewport = document.locator('[data-markdown-viewport]');
      expect(await viewport.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThan(3);
      expect(await viewport.locator('[data-transcript-row-key]').count()).toBeLessThan(35);
      const article = page.locator('article').filter({ has: document });
      if (imageCount) {
        const bounds = await article.evaluate(node => ({
          right: node.getBoundingClientRect().right,
          imagesRight: Math.max(...Array.from(node.querySelectorAll('img')).map(image => image.closest('button')!.getBoundingClientRect().right)),
        }));
        expect(Math.abs(bounds.right - bounds.imagesRight)).toBeLessThan(2);
      }
      await viewport.evaluate(node => { node.scrollTop = node.scrollHeight; });
      await expect(viewport.getByText(paragraphs.at(-1)!, { exact: true })).toBeVisible();
    }
  }
});

test('short user messages and image-only turns retain their compact size', async ({ page }) => {
  for (const [text, imageCount] of [['Ok', 0], ['', 1]] as const) {
    await page.evaluate(args => (window as any).chatFixture.layout(args), { text, imageCount });
    await expect(page.locator('[data-large-markdown]')).toHaveCount(0);
    const article = page.locator('.chat-transcript article').first();
    await expect(page.locator('.chat-transcript img')).toHaveCount(imageCount);
    if (text) await expect(article.getByText(text, { exact: true })).toBeVisible();
    await expect(article).toBeVisible();
    expect((await article.boundingBox())!.width).toBeLessThan(imageCount ? 135 : 90);
  }
});
