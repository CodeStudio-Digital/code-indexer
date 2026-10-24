import { expect, test } from '@playwright/test';

const common = { baselineId: 'baseline', filePath: 'src/example.ts', status: 'active', existedBefore: true, oversized: false,
  firstSeenAt: '2026-10-24T00:00:00Z', lastEditedAt: '2026-10-24T00:01:00Z', closedAt: null,
  hunkCount: 1, pendingHunks: 1, removedLines: 1, resolved: false };
const first = { ...common, addedLines: 2, toolUseId: 'first', fileIndex: 0, existedAfter: true };
const second = { ...common, addedLines: 1, removedLines: 0, toolUseId: 'second', fileIndex: 0, existedAfter: true };
const total = { ...common, addedLines: 3, roundMessageId: 1, roundSnapshotId: 'round', globalBaselineId: 'baseline' };
function diff(which: string) {
  const lines = which === 'second' ? [{ type: 'add', content: 'second', newLine: 2 }]
    : [{ type: 'remove', content: 'original', oldLine: 1 }, { type: 'add', content: 'first', newLine: 1 },
      ...(which === 'total' ? [{ type: 'add', content: 'second', newLine: 2 }] : []),
      { type: 'add', content: 'extra', newLine: which === 'total' ? 3 : 2 }];
  return { baseline: { id: 'baseline', filePath: common.filePath, existedBefore: true, oversized: false, status: 'active' },
    hunks: [{ fingerprint: which, oldStart: 1, newStart: 1, oldLines: which === 'second' ? 0 : 1,
      newLines: lines.length - (which === 'second' ? 0 : 1), lines, decision: 'pending',
      addedCount: which === 'total' ? 3 : which === 'first' ? 2 : 1, removedCount: which === 'second' ? 0 : 1,
      hiddenBefore: 0, hiddenAfter: 0, canExpandBefore: false, canExpandAfter: false }], diffDisabled: false, currentContent: null };
}

test('edit cards retain their own counts and lines through streaming, later edits and reload; summary and modal keep totals', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const requests: string[] = [];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname; requests.push(path);
    const tool = path.match(/\/tool\/([^/]+)/)?.[1];
    let json: unknown = { files: [] };
    if (tool) json = path.endsWith('/diff') ? diff(tool) : { files: tool === 'first' ? [first] : tool === 'second' ? [second] : [] };
    else if (path.endsWith('/diff')) json = diff('total');
    else if (path.endsWith('/reviews')) json = { runs: [], comments: [] };
    else json = { files: [total], reviews: [], roundMessageId: 1 };
    return route.fulfill({ json });
  });
  const open = async () => { await page.goto('/e2e/fixtures/tool-snapshots.html'); await expect(page.getByTestId('first')).toBeVisible(); };
  await open();
  await expect(page.getByTestId('first')).not.toContainText('+3');
  expect(requests.some(url => url.endsWith('/tool/first'))).toBe(false);
  await page.evaluate(() => (window as any).snapshotFixture.finish());
  for (const [id, count] of [['first', '+2'], ['second', '+1']]) await expect(page.getByTestId(id!)).toContainText(count!);
  await expect(page.getByTestId('legacy').getByRole('button')).toBeDisabled();
  await expect(page.getByTestId('legacy')).not.toContainText('+3');
  await page.evaluate(() => (window as any).snapshotFixture.later());
  await expect(page.getByTestId('first')).toContainText('+2');
  await expect(page.getByTestId('first')).not.toContainText('+99');
  await page.getByTestId('first').getByRole('button').click();
  await expect(page.getByTestId('first').getByText('original', { exact: true })).toBeVisible();
  await expect(page.getByTestId('first').getByText('extra', { exact: true })).toBeVisible();
  await expect(page.getByTestId('first').getByText('second', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('first').getByRole('button')).toHaveCount(1);
  await page.getByTestId('second').getByRole('button').click();
  await expect(page.getByTestId('second').getByText('second', { exact: true })).toBeVisible();
  await expect(page.getByTestId('second').getByText('original', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('summary')).toContainText('+3');
  await page.getByTestId('summary').getByRole('button', { name: /View snapshot|Ver snapshot/i }).click();
  const modal = page.getByRole('dialog'); await expect(modal).toBeVisible();
  await expect(modal.getByText('original', { exact: true })).toBeVisible();
  await expect(modal.getByText('second', { exact: true })).toBeVisible();
  await expect(modal).toContainText('+3');
  await page.keyboard.press('Escape');
  await open(); await page.evaluate(() => (window as any).snapshotFixture.finish());
  await expect(page.getByTestId('first')).toContainText('+2');
  await expect(page.getByTestId('second')).toContainText('+1');
  await page.screenshot({ path: '.tmp/tool-snapshots.png', fullPage: true });
  expect(errors).toEqual([]);
});
