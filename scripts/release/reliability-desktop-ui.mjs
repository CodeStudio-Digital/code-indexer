/** Renderer interactions against the unchanged packaged app and real IPC. */
import { expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function verifyDesktopUi({ page, output }) {
  await expect(page.locator('.workbench-shell')).toBeVisible({ timeout: 30_000 });
  const setup = page.getByRole('button', { name: 'Continue', exact: true });
  if (await setup.isVisible()) { await expect(setup).toBeEnabled({ timeout: 30_000 }); await setup.click(); }
  await page.screenshot({ path: join(output, 'offline-workbench.png'), fullPage: true });
  writeFileSync(join(output, 'ui-initial.txt'), await page.locator('body').innerText());
  const files = page.getByRole('button', { name: 'Files', exact: true });
  if (await files.getAttribute('aria-pressed') !== 'true') await files.click();
  const filter = page.getByPlaceholder(/Filter files|Filtrar arquivos/);
  await filter.fill('CanaryPolicy');
  await page.getByRole('treeitem').filter({ hasText: 'CanaryPolicy.ts' }).first().dblclick();
  await expect(page.locator('.monaco-editor').first()).toBeVisible();
  await page.screenshot({ path: join(output, 'offline-editor.png'), fullPage: true });
  // The titlebar button opens the global command palette. Project file search
  // is the registered Go to File shortcut; move focus out of Monaco first.
  await files.focus();
  await page.keyboard.press('Control+Shift+n');
  await expect(page.getByRole('dialog')).toBeVisible();
  const search = page.getByRole('dialog').getByRole('textbox');
  await search.fill('CanaryNew');
  await expect(page.getByRole('dialog').getByText('CanaryNew.ts', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: join(output, 'offline-search.png'), fullPage: true });
  console.log('UI passed: editor and fresh-file search');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Databases', exact: true }).click();
  await expect(page.getByRole('tablist', { name: /Database tools|Ferramentas do banco de dados/ })).toBeVisible();
  await page.screenshot({ path: join(output, 'offline-database.png'), fullPage: true });
  writeFileSync(join(output, 'ui-database.txt'), await page.locator('body').innerText());
  await page.getByRole('button', { name: 'New connection', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('My database').fill('Canary SQLite');
  await dialog.getByRole('combobox').first().selectOption('sqlite');
  await dialog.getByPlaceholder('C:/path/to/db.sqlite').fill(join(output, 'fixture.sqlite'));
  await dialog.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(page.getByText('Connection OK', { exact: true })).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const connection = page.getByText('Canary SQLite · SQLite', { exact: true });
  await connection.click();
  await connection.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New query', exact: true }).click();
  console.log('UI passed: saved SQLite connection; query editor opened');
  const sqlEditor = page.locator('.monaco-editor:visible');
  await expect(sqlEditor).toHaveCount(1);
  await sqlEditor.click({ position: { x: 100, y: 15 } });
  await expect(sqlEditor.locator('textarea')).toBeFocused();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText('SELECT tenant, id, value FROM fixture ORDER BY tenant;');
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText('two', { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: join(output, 'offline-query.png'), fullPage: true });
  writeFileSync(join(output, 'ui-query.txt'), await page.locator('body').innerText());
  await page.reload();
  await expect(page.getByText('Canary SQLite · SQLite', { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: join(output, 'offline-reload.png'), fullPage: true });
  return { ui: { workbench: 'passed', editor: 'passed', searchFreshFile: 'passed', databaseNavigation: 'passed', sqliteConnectionAndQuery: 'passed', savedConnectionAfterReload: 'passed' } };
}
