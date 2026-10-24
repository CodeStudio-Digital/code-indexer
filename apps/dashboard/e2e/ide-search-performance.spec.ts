import { expect, test } from '@playwright/test';

/** Run against Vite; no backend or user data is required. */
test('keeps file search bounded, ignores stale responses and virtualizes matches', async ({ page }) => {
  const errors: string[] = [];
  const queries: Array<{ query: string | null; limit: number; fuzzy: string | null }> = [];
  let fullListings = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    let body: unknown = [];
    if (url.pathname.endsWith('/file-paths')) {
      const query = url.searchParams.get('query');
      queries.push({ query, limit: Number(url.searchParams.get('limit')), fuzzy: url.searchParams.get('fuzzy') });
      if (query === 'old') await new Promise((resolve) => setTimeout(resolve, 300));
      body = url.searchParams.get('fuzzy') === 'false'
        ? Array.from({ length: 300 }, (_, i) => ({ path: `src/${query}-${i}.ts` }))
        : [{ path: `src/${query}.tsx` }];
    } else if (url.pathname.endsWith('/files')) fullListings++;
    else if (url.pathname.endsWith('/file-tree')) body = { name: '.', path: '', type: 'dir', children: [] };
    else if (url.pathname.includes('git')) body = { files: [], notARepo: true, repoRoot: null };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
  });

  await page.goto('/e2e/fixtures/ide-search.html');
  await page.waitForFunction(() => typeof (window as unknown as { openSearch: unknown }).openSearch === 'function');
  await page.evaluate(() => (window as unknown as { openSearch(): void }).openSearch());
  const input = page.getByRole('dialog').locator('input');
  await input.fill('old');
  await expect.poll(() => queries.some((entry) => entry.query === 'old')).toBe(true);
  await input.fill('workspace');
  await expect(page.getByRole('dialog').getByText('src/workspace.tsx', { exact: true })).toBeVisible();
  await page.waitForTimeout(350); // Let the deliberately delayed stale response finish.
  await expect(page.getByRole('dialog').getByText('src/old.tsx', { exact: true })).toHaveCount(0);
  await input.press('Enter');
  await expect(page.locator('body')).toHaveAttribute('data-opened', 'src/workspace.tsx');

  await page.getByTestId('tree').locator('input').fill('component');
  const rows = page.getByTestId('tree').getByRole('treeitem');
  await expect.poll(() => rows.count()).toBeGreaterThan(0);
  expect(await rows.count()).toBeLessThan(60);
  expect(queries).toContainEqual({ query: 'component', limit: 300, fuzzy: 'false' });
  expect(fullListings).toBe(0);
  expect(errors).toEqual([]);
});
