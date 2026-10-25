import { expect, test } from '@playwright/test';
import sharp from 'sharp';

test('selects skills on demand and recovers attachments and generated session files', async ({ page }) => {
  const pixels = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#7464ca' } }).png().toBuffer();
  const errors: string[] = [], requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('i18n-lang', 'pt-BR');
    (window as any).electronAPI = { openPath: (path: string) => { (window as any).openedSessionPath = path; } };
  });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()); const path = url.pathname; requests.push(path);
    if (path === '/api/coder/skills/suggestions') return route.fulfill({ json: { commands: [
      { id: 'react', name: 'React Architecture', description: 'Arquitetura de aplicações React', command: 'react-arch' },
      { id: 'review', name: 'Revisão de código', description: 'Revisar alterações do projeto', command: null },
    ] } });
    if (path.endsWith('/attachments')) return route.fulfill({ json: {
      items: url.searchParams.get('offset') === '50'
        ? [{ seq: 80, index: 0, name: 'ultimo.txt', size: 10, downloadable: true }]
        : [{ seq: 1, index: 0, name: 'design.pdf', size: 2000, downloadable: true, origin: 'sent' },
          { seq: 2, index: 1, name: 'captura.png', size: 1800, downloadable: true, media_type: 'image/png', origin: 'sent' },
          { seq: 3, index: 0, name: 'generated-image.png', size: pixels.length, downloadable: true, media_type: 'image/png', origin: 'generated' }],
      total: 51, next_offset: url.searchParams.get('offset') === '50' ? null : 50,
    } });
    if (/\/attachments\/\d+\/\d+$/.test(path)) {
      if (url.searchParams.has('thumbnail') || url.searchParams.has('preview')) return route.fulfill({ body: pixels, contentType: 'image/png' });
      return route.fulfill({ body: 'original attachment', headers: { 'Content-Disposition': 'attachment; filename="design.pdf"', 'Content-Type': 'application/octet-stream' } });
    }
    if (path.endsWith('/files')) {
      if (url.searchParams.has('download')) return route.fulfill({ body: 'generated report', headers: { 'Content-Disposition': 'attachment; filename="report.md"', 'Content-Type': 'application/octet-stream' } });
      const folder = url.searchParams.get('path');
      return route.fulfill({ json: { root_path: 'D:/fixture/session', path: folder || '', parent: folder ? '' : null, next_offset: null,
        entries: folder ? [{ name: 'report.md', path: 'generated/report.md', type: 'file' }] : [{ name: 'generated', path: 'generated', type: 'directory' }],
      } });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto('/e2e/fixtures/session-context.html');
  await expect(page.getByText('design.pdf', { exact: true })).toBeVisible();
  await expect(page.getByText('generated-image.png', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Abrir imagem 1: generated-image.png' }).click();
  const imageViewer = page.getByRole('dialog');
  await expect(imageViewer.getByRole('img', { name: 'generated-image.png' })).toBeVisible();
  await expect(imageViewer.getByRole('img')).toHaveJSProperty('naturalWidth', 640);
  await page.keyboard.press('Escape');
  expect(requests.some(path => path.includes('/skills'))).toBe(false);
  await expect(page.getByRole('button', { name: 'Skills', exact: true })).toHaveCount(0);
  const input = page.locator('textarea');
  // A pasted command with arguments is submitted before the picker debounce fires.
  await input.fill('/react-arch confira este projeto');
  await input.press('Control+Enter');
  await expect(page.getByTestId('sent')).toContainText('"skills":["react"]');
  await expect(page.getByTestId('sent')).toContainText('/react-arch confira este projeto');
  await input.fill('Revise com #rea');
  await expect(page.getByRole('listbox', { name: 'Skills' })).toBeVisible();
  await expect(page.getByRole('option', { name: /React Architecture/ })).toBeVisible();
  await page.screenshot({ path: '.tmp/session-context-skills.png' });
  await input.press('Enter');
  await expect(input).toHaveValue('Revise com ');
  await input.press('Control+Enter');
  await expect(page.getByTestId('sent')).toContainText('"skills":["react"]');

  await page.getByRole('button', { name: 'Alternar execução' }).click();
  await input.fill('Depois #review');
  await page.getByRole('option', { name: /Revisão de código/ }).click();
  await input.press('Control+Enter');
  await expect(page.getByTestId('sent')).toContainText('"skills":["review"]');
  await expect(page.getByTestId('sent')).toContainText('"mode":"next-turn"');
  await page.getByRole('button', { name: 'Alternar execução' }).click();
  await input.fill('/react');
  await page.getByRole('option', { name: /react-arch/ }).click();
  await input.press('Control+Enter');
  await expect(page.getByTestId('sent')).toContainText('"text":"/react-arch "');
  await expect(page.getByTestId('sent')).toContainText('"skills":["react"]');

  await page.getByRole('button', { name: 'Carregar mais' }).click();
  await expect(page.getByText('ultimo.txt', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Baixar design.pdf' }).click();
  expect((await download).suggestedFilename()).toBe('design.pdf');
  await page.screenshot({ path: '.tmp/session-context-attachments.png' });
  await page.getByRole('tab', { name: 'Arquivos da sessão', exact: true }).click();
  await page.getByRole('button', { name: 'generated', exact: true }).click();
  await expect(page.getByRole('link', { name: 'report.md' })).toBeVisible();
  await page.getByRole('button', { name: 'Abrir pasta no Explorer' }).click();
  expect(await page.evaluate(() => (window as any).openedSessionPath)).toBe('D:/fixture/session');
  const report = page.waitForEvent('download');
  await page.getByRole('link', { name: 'report.md' }).click();
  expect((await report).suggestedFilename()).toBe('report.md');
  await page.screenshot({ path: '.tmp/session-context-files.png' });
  await page.getByRole('button', { name: 'Outra sessão' }).click();
  await expect(page.getByRole('tab', { name: 'Anexos', exact: true })).toHaveAttribute('data-state', 'active');
  expect(requests.some(path => path.endsWith('/skills/slash-commands'))).toBe(false);
  expect(errors).toEqual([]);
});
