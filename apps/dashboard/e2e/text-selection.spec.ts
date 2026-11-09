import { expect, test, type Locator, type Page } from '@playwright/test';

async function mountSelectionFixture(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById('root')?.setAttribute('hidden', '');
    const fixture = document.createElement('section');
    fixture.id = 'text-selection-fixture';
    fixture.style.cssText = 'padding:24px;font:16px/1.5 sans-serif;display:grid;gap:12px;';
    fixture.innerHTML = `
      <div data-testid="empty-state" style="width:max-content">Start a conversation</div>
      <nav data-testid="rail" style="width:max-content">Project tools</nav>
      <div data-testid="content" data-text-selectable style="width:max-content">
        Selectable session content
        <button data-testid="content-button" type="button">Session action</button>
      </div>
      <div data-testid="markdown" class="prose" style="width:max-content">Rendered markdown content</div>
      <pre data-testid="code" style="width:max-content">const selectable = true;</pre>
      <div data-testid="diff" class="diff-block" style="width:max-content">+ selectable diff line</div>
      <textarea data-testid="textarea">Editable draft text</textarea>
      <div data-testid="editable" contenteditable="true" style="width:max-content">Editable rich text</div>
    `;
    document.body.appendChild(fixture);
  });
}

async function dragSelection(page: Page, locator: Locator): Promise<string> {
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('Selection fixture element has no bounding box');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.max(4, box.width - 3), y, { steps: 8 });
  await page.mouse.up();
  return page.evaluate(() => window.getSelection()?.toString() ?? '');
}

test.describe('Electron text-selection policy', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('mcp-ide:onboarded', 'true');
      localStorage.setItem('codestudio:preflight-done', 'true');
      localStorage.setItem('mcp-cloud:gate-bypass', '1');
    });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-app-runtime', 'browser');
    await mountSelectionFixture(page);
  });

  test('keeps ordinary browser selection unchanged', async ({ page }) => {
    const emptyState = page.getByTestId('empty-state');
    await expect(emptyState).not.toHaveCSS('user-select', 'none');
    expect(await dragSelection(page, emptyState)).toContain('Start a conversation');
  });

  test('keeps desktop text selectable while controls remain unselectable', async ({ page }) => {
    await page.evaluate(() => {
      document.documentElement.dataset.appRuntime = 'electron';
    });

    await expect(page.locator('body')).toHaveCSS('user-select', 'text');
    await expect(page.getByTestId('empty-state')).toHaveCSS('user-select', 'text');
    await expect(page.getByTestId('rail')).toHaveCSS('user-select', 'none');
    await expect(page.getByTestId('content')).toHaveCSS('user-select', 'text');
    await expect(page.getByTestId('content-button')).toHaveCSS('user-select', 'none');
    await expect(page.getByTestId('markdown')).toHaveCSS('user-select', 'text');
    await expect(page.getByTestId('code')).toHaveCSS('user-select', 'text');
    await expect(page.getByTestId('diff')).toHaveCSS('user-select', 'text');
    await expect(page.getByTestId('textarea')).toHaveCSS('user-select', 'text');
    await expect(page.getByTestId('editable')).toHaveCSS('user-select', 'text');

    expect(await dragSelection(page, page.getByTestId('empty-state'))).toContain('Start a conversation');
    expect(await dragSelection(page, page.getByTestId('content'))).toContain('Selectable session content');
    expect(await dragSelection(page, page.getByTestId('content-button'))).toBe('');
    expect(await dragSelection(page, page.getByTestId('code'))).toContain('const selectable = true;');

    const textarea = page.getByTestId('textarea');
    await textarea.selectText();
    expect(await textarea.evaluate((element) => {
      const field = element as HTMLTextAreaElement;
      return (field.selectionEnd ?? 0) - (field.selectionStart ?? 0);
    })).toBeGreaterThan(0);
  });
});
