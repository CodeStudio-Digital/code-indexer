import { expect, test } from '@playwright/test';

test('opens a global session without a ref-driven render loop', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.addInitScript(() => {
    localStorage.setItem('mcp-ide:onboarded', 'true');
    localStorage.setItem('chatRightPanelId', 'meta');
  });

  await page.goto('/#/global');
  const globalRows = page.getByRole('complementary').locator('[data-session-id]');
  await expect(globalRows.first()).toBeVisible();

  await globalRows.first().click();

  await expect(page.locator('.workbench-surface')).toHaveCount(3);
  await expect(page.locator('nav[aria-label="Session tools"]')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('reattaches when switching A to B to A without a render error', async ({ page }) => {
  const pageErrors: string[] = [];
  const attachRequests: string[] = [];
  const sessionReads: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/attach')) attachRequests.push(request.url());
    if (/\/api\/coder\/sessions\/[0-9a-f-]+$/i.test(url.pathname)) sessionReads.push(request.url());
  });
  await page.route('/api/**', async (route) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  await page.addInitScript(() => {
    localStorage.setItem('mcp-ide:onboarded', 'true');
    localStorage.setItem('i18nextLng', 'en');
  });

  await page.goto('/#/global');
  const rows = page.getByRole('complementary').locator('[data-session-id]');
  await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(2);
  const firstId = await rows.nth(0).getAttribute('data-session-id');
  const secondId = await rows.nth(1).getAttribute('data-session-id');
  expect(firstId).toBeTruthy();
  expect(secondId).toBeTruthy();

  await rows.nth(0).click();
  await expect.poll(() => attachRequests.filter((url) => url.includes(firstId!)).length).toBeGreaterThanOrEqual(1);
  await rows.nth(1).click();
  await expect.poll(() => sessionReads.filter((url) => url.includes(secondId!)).length).toBeGreaterThanOrEqual(1);
  await rows.nth(0).click();
  await expect.poll(() => sessionReads.filter((url) => url.includes(firstId!)).length).toBeGreaterThanOrEqual(2);
  expect(attachRequests.filter((url) => url.includes(firstId!))).toHaveLength(1);

  await page.goto(`/#/global?session=${firstId}`);
  await page.reload();
  await expect.poll(() => attachRequests.filter((url) => url.includes(firstId!)).length).toBeGreaterThanOrEqual(2);
  await expect(page.locator('nav[aria-label="Session tools"]')).toBeVisible();

  expect(pageErrors).toEqual([]);
});
