import { expect, test } from '@playwright/test';

test('retires My Apps links while keeping project creation and old URL recovery', async ({ page }) => {
  const errors: string[] = [];
  const retiredRequests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('mcp-ide:onboarded', 'true');
    localStorage.setItem('i18n-lang', 'pt-BR');
    localStorage.setItem('theme', 'dark');
  });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/app-studio')) retiredRequests.push(path);
    if (path.endsWith('/notifications')) return route.fulfill({ json: { notifications: [], unread: 0 } });
    if (path === '/api/config/features') return route.fulfill({ json: {} });
    return route.fulfill({ json: [] });
  });

  for (const retiredPath of ['/apps', '/apps/11111111-1111-4111-8111-111111111111']) {
    await page.goto(`/#${retiredPath}`);
    await expect(page).toHaveURL(/\/#\/$/);
    await expect(page.getByRole('button', { name: 'Novo projeto', exact: true })).toBeVisible();
    await expect(page.getByText('Meus apps', { exact: true })).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Menu do aplicativo', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Projetos', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Agentes', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Meus apps', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Novo projeto', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('Criar app completo com IA', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog').getByText('React + Vite', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(retiredRequests).toEqual([]);
  expect(errors).toEqual([]);
  await page.screenshot({ path: '.tmp/app-studio-retired.png' });
});
