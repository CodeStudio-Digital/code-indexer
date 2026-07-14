import { expect, test, type Page } from '@playwright/test';

const projectId = process.env.CODESTUDIO_E2E_PROJECT_ID;
const editorFileFilter = process.env.CODESTUDIO_E2E_FILE_FILTER ?? 'package.json';

async function openProjectSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Project settings|Configurações do projeto/ }).click();
  await expect(page.getByRole('navigation', { name: /Settings|Configurações/ })).toBeVisible();
}

async function remapVisibleAction(page: Page, commandId: string, shortcut: string): Promise<void> {
  const search = page.getByPlaceholder(/Search action|Buscar por ação/);
  await search.fill(commandId);
  const row = page.locator(`[data-command-id="${commandId}"]`);
  await row.getByRole('button', { name: /Shortcut|Atalho/ }).click();
  await page.keyboard.press(shortcut);
  await expect(row).toContainText(shortcut.replace('Control', 'Ctrl'));
}

test.describe('professional editor settings and keymap', () => {
  test.skip(!projectId, 'Set CODESTUDIO_E2E_PROJECT_ID to a local fixture project.');

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('mcp-ide:onboarded', 'true');
      localStorage.setItem('theme', 'dark');
    });
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByRole('tab', { name: 'Code', exact: true })).toBeVisible();
  });

  test('exposes editor panes and persists comment and format remaps after reload', async ({ page }) => {
    await openProjectSettings(page);

    await page.getByRole('button', { name: /Estilo de código|Code style/ }).click();
    const formatOnSave = page.getByText(/Formatar ao salvar|Format on save/, { exact: true })
      .locator('xpath=ancestor::div[.//*[@role="switch"]][1]')
      .getByRole('switch');
    await expect(formatOnSave).not.toBeChecked();

    await page.getByRole('button', { name: 'Keymap', exact: true }).click();
    await remapVisibleAction(page, 'editor.toggleLineComment', 'Control+Shift+8');
    await remapVisibleAction(page, 'editor.format', 'Control+Shift+9');

    await page.reload();
    await openProjectSettings(page);
    await page.getByRole('button', { name: 'Keymap', exact: true }).click();
    const search = page.getByPlaceholder(/Search action|Buscar por ação/);
    await search.fill('editor.toggleLineComment');
    await expect(page.locator('[data-command-id="editor.toggleLineComment"]')).toContainText('Ctrl+Shift+8');

    await page.getByRole('button', { name: 'Autocomplete', exact: true }).click();
    await expect(page.getByText(/Languages, server and formatter|Linguagens, servidor e formatter/)).toBeVisible();
    await expect(page.getByText('AI ghost text', { exact: true })).toBeVisible();
  });

  test('mounts a real Monaco file without unstable external-store snapshots', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const filter = page.getByPlaceholder(/Filter files|Filtrar arquivos/);
    await filter.fill(editorFileFilter);
    await page.getByRole('treeitem').filter({ hasText: editorFileFilter }).first().dblclick();
    await expect(page.locator('.monaco-editor').first()).toBeVisible();
    await openProjectSettings(page);
    await page.getByRole('button', { name: /Geral|General/, exact: true }).last().click();
    await expect(page.getByText(/Família da fonte|Font family/, { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(500);

    expect(pageErrors.filter((message) => message.includes('Maximum update depth exceeded'))).toEqual([]);
  });
});
