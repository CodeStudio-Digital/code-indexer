import { expect, test } from '@playwright/test';

for (const compact of [false, true]) {
  test(`provider selection is acknowledged before sending (${compact ? 'editor' : 'chat'})`, async ({ page }) => {
    const sent: unknown[] = [], changes: Array<{ provider: string; model: string }> = [], errors: string[] = [];
    let rejectSwitch = true;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/switch')) {
        const body = route.request().postDataJSON(); changes.push(body);
        if (rejectSwitch) return route.fulfill({ status: 503, json: { error: 'Meridian temporariamente indisponível' } });
        return route.fulfill({ json: { ok: true, ...body } });
      }
      if (path.endsWith('/messages')) {
        sent.push(route.request().postDataJSON());
        return route.fulfill({ contentType: 'text/event-stream', body: 'event: done\ndata: {"reason":"complete"}\n\n' });
      }
      return route.fulfill({ json: [] });
    });
    await page.goto(`/e2e/fixtures/provider-selection.html${compact ? '?compact=1' : ''}`);
    await page.getByRole('button', { name: /OpenAI API.*gpt-test/ }).click();
    await page.getByRole('combobox').first().click();
    await page.getByRole('listbox').getByRole('option', { name: 'Meridian', exact: true }).click();
    await expect.poll(() => changes.length).toBe(1);
    expect(changes[0]).toEqual({ provider: 'meridian', model: 'antigravity/gemini-4-argon-medium' });
    await page.getByRole('button', { name: 'Fechar', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Meridian temporariamente indisponível');
    await expect(page.getByTestId('selection')).toContainText('meridian · antigravity/gemini-4-argon-medium');
    await expect(page.getByTestId('header')).toContainText('openai-api · gpt-test');
    await page.locator('textarea').fill('Oi');
    await expect(page.getByRole('button', { name: /Enviar/ })).toBeDisabled();
    await page.locator('textarea').press('Control+Enter');
    expect(sent).toHaveLength(0);
    rejectSwitch = false;
    await page.getByRole('button', { name: 'Tentar novamente' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByTestId('header')).toContainText('meridian · antigravity/gemini-4-argon-medium');
    await expect(page.locator('textarea')).toHaveValue('Oi');
    await page.getByRole('button', { name: /Enviar/ }).click();
    await expect.poll(() => sent.length).toBe(1);
    await page.getByRole('button', { name: 'Outra sessão' }).click();
    await expect(page.getByTestId('selection')).toContainText('openai-api · gpt-test');
    expect(errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath(`provider-${compact ? 'editor' : 'chat'}.png`) });
  });
}

test('rapid provider and model changes are saved in order before sending', async ({ page }) => {
  const changes: Array<{ provider: string; model: string }> = [];
  let releaseFirst!: () => void;
  const first = new Promise<void>(resolve => { releaseFirst = resolve; });
  await page.route('**/api/**', async route => {
    if (new URL(route.request().url()).pathname.endsWith('/switch')) {
      const body = route.request().postDataJSON();
      changes.push(body);
      if (changes.length === 1) await first;
      return route.fulfill({ json: { ok: true, ...body } });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto('/e2e/fixtures/provider-selection.html');
  await page.getByRole('button', { name: /OpenAI API.*gpt-test/ }).click();
  await page.getByRole('combobox').first().click();
  await page.getByRole('listbox').getByRole('option', { name: 'Meridian', exact: true }).click();
  await expect.poll(() => changes.length).toBe(1);
  await page.getByRole('combobox').nth(1).click();
  await page.getByRole('listbox').getByRole('option', { name: 'gemini-fast', exact: true }).click();
  await page.getByRole('button', { name: 'Fechar', exact: true }).click();
  await expect(page.getByTestId('selection')).toContainText('meridian · gemini-fast');
  await expect(page.getByTestId('header')).toContainText('openai-api · gpt-test');
  await page.locator('textarea').fill('Preservar rascunho');
  await expect(page.getByRole('button', { name: /Enviar/ })).toBeDisabled();
  expect(changes).toHaveLength(1);
  releaseFirst();
  await expect(page.getByTestId('header')).toContainText('meridian · gemini-fast');
  expect(changes).toEqual([
    { provider: 'meridian', model: 'antigravity/gemini-4-argon-medium' },
    { provider: 'meridian', model: 'gemini-fast' },
  ]);
  await expect(page.getByRole('button', { name: /Enviar/ })).toBeEnabled();
  await expect(page.locator('textarea')).toHaveValue('Preservar rascunho');
});
