import { expect, test } from '@playwright/test';

const VIEWPORTS = [
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1280x720', width: 1280, height: 720 },
  { name: 'mobile-390x844', width: 390, height: 844 },
] as const;

test('captures the legacy global-session visual matrix without writes', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  const blockedWrites: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('/api/**', async (route) => {
    const method = route.request().method();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      blockedWrites.push(`${method} ${new URL(route.request().url()).pathname}`);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  await page.addInitScript(() => {
    localStorage.setItem('mcp-ide:onboarded', 'true');
    localStorage.setItem('i18nextLng', 'en');
    localStorage.setItem('theme', 'dark');
    localStorage.setItem('chatRightPanelId', 'worker-log');
  });

  await page.goto('/#/global');
  const rows = page.getByRole('complementary').locator('[data-session-id]');
  await expect(rows.first()).toBeVisible();
  await rows.first().click();
  await expect(page.locator('.workbench-surface')).toHaveCount(3);

  const matrix: Array<{
    viewport: string;
    surfaces: number;
    railVisible: boolean;
    sidebarVisible: boolean;
    workerLogVisible: boolean;
  }> = [];
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(250);
    const rail = page.locator('nav[aria-label="Session tools"]');
    const sidebar = page.getByRole('complementary').first();
    const workerLog = page.getByText('Log do worker', { exact: true }).or(page.getByText('Worker log', { exact: true }));
    matrix.push({
      viewport: viewport.name,
      surfaces: await page.locator('.workbench-surface:visible').count(),
      railVisible: await rail.isVisible(),
      sidebarVisible: await sidebar.isVisible(),
      workerLogVisible: await workerLog.first().isVisible(),
    });
    await testInfo.attach(`legacy-global-${viewport.name}.png`, {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
  }

  console.log(`CSW_VISUAL_BASELINE ${JSON.stringify({ matrix, blockedWrites, pageErrors })}`);
  expect(blockedWrites.filter((request) =>
    request !== 'POST /api/admin/perf/renderer-freezes',
  )).toEqual([]);
  expect(pageErrors).toEqual([]);
});
