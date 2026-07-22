import { expect, test } from '@playwright/test';

test('opens a global session without a ref-driven render loop', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.addInitScript(() => {
    localStorage.setItem('mcp-ide:onboarded', 'true');
    localStorage.setItem('chatRightPanelId', 'meta');
  });

  await page.goto('/global');
  const globalRows = page.getByRole('complementary').locator('[data-session-id]');
  await expect(globalRows.first()).toBeVisible();

  await globalRows.first().click();

  await expect(page.locator('.workbench-surface')).toHaveCount(3);
  await expect(page.locator('nav[aria-label="Session tools"]')).toBeVisible();
  expect(pageErrors).toEqual([]);
});
