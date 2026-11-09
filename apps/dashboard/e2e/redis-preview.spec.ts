import { expect, test } from '@playwright/test';

test('a partial Redis string cannot be saved over the complete value', async ({ page }) => {
  await page.goto('/e2e/fixtures/redis-preview.html');
  await expect(page.getByRole('status')).toContainText('Partial preview');
  await expect(page.locator('textarea')).toHaveAttribute('readonly', '');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { previewCalls: string[] }).previewCalls)).toEqual(['get']);
});

test('a failed preview stays noneditable', async ({ page }) => {
  await page.goto('/e2e/fixtures/redis-preview.html?mode=failed');
  await expect(page.getByRole('status')).toContainText('Partial preview');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});

test('a complete value remains editable and saves through the normal command', async ({ page }) => {
  await page.goto('/e2e/fixtures/redis-preview.html?mode=complete');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await page.locator('textarea').fill('updated');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-saved', 'true');
  expect(await page.evaluate(() => (window as unknown as { previewCalls: string[] }).previewCalls)).toEqual(['get', 'set']);
});
