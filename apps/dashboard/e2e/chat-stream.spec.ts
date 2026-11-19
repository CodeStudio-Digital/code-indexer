import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { AssistantTurn } from '../hooks/agent-stream/types.js';
import type { MessageRow, PersistedMessage } from '../features/chat/types.js';

function showTranscript(page: Page, messages: PersistedMessage[], rows: MessageRow[], turn: AssistantTurn | null = null,
  { precedingUser, ...state }: { precedingUser?: number; streaming?: boolean; preflight?: { startedAt: number }; doneReason?: string; error?: string } = {}) {
  const data = { messages, message_rows: rows, total_messages: rows.length, preceding_user_seq: precedingUser };
  return page.evaluate(value => (window as any).chatFixture.transcript(value), { data, turn, streaming: !!turn, ...state });
}

async function checkTurnTokens(page: Page, trigger: Locator, counts: string[]) {
  await trigger.focus();
  await page.keyboard.press('Enter');
  const details = page.locator('[data-turn-usage]');
  await expect(details).toBeVisible();
  await expect(details.locator('dd')).toHaveText(counts);
  await page.keyboard.press('Escape');
  await expect(details).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    let clipboard = '';
    Object.defineProperty(navigator, 'clipboard', { value: {
      writeText: async (text: string) => { clipboard = text; },
      readText: async () => clipboard,
    } });
  });
  await page.route('**/api/**', route => route.fulfill({ json: { chapters: [], items: [], has_more: false } }));
  await page.goto('/e2e/fixtures/chat-stream.html');
  await expect(page.locator('.chat-transcript')).toBeVisible();
});

test('message links open beside the conversation, including virtual Markdown and nested files', async ({ page, context }) => {
  const paths: string[] = [];
  const markdown = '## Resultado\r\n\r\n[Tabela anexa](files/index.tsv#L2)\r\n';
  const tsv = 'item\tclasse\r\n34\tExemplo';
  await page.route('**/linked-file?*', async route => {
    const path = new URL(route.request().url()).searchParams.get('path')!;
    paths.push(path);
    if (path === 'missing.md') return route.fulfill({ status: 404, json: { error: 'missing' } });
    const report = path === 'docs/README.md';
    return route.fulfill({ json: {
      path: report ? 'docs/README.md' : 'docs/files/index.tsv', absolutePath: report ? 'D:/project/docs/README.md' : path,
      content: report ? markdown : tsv,
      isBinary: false, truncated: false, projectId: 1, worktreePath: null,
    } });
  });
  await page.evaluate(() => {
    (window as any).electronAPI = { openExternal: (url: string) => { (window as any).openedWebsite = url; } };
  });
  const before = context.pages().length;
  const url = page.url();
  for (const long of [false, true]) {
    const text = '[Abrir relatório](docs/README.md) · [Arquivo movido](missing.md) · [Site de exemplo](https://example.org/)'
      + (long ? '\n\n' + 'Parágrafo do relatório.\n\n'.repeat(900) : '');
    await showTranscript(page, [{ role: 'assistant', content: [{ type: 'text', text }] }],
      [{ id: 'links', seq: 1, input_tokens: 1, output_tokens: 1 }]);
    if (long) await expect(page.locator('[data-large-markdown]')).toHaveAttribute('data-markdown-ready', 'true', { timeout: 15_000 });
    const link = page.getByRole('link', { name: 'Abrir relatório' });
    await link.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Resultado' })).toBeVisible();
    const copy = dialog.getByRole('button', { name: /^(Copy content|Copiar conteúdo)$/ });
    await copy.focus();
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('button', { name: /^(Copied!|Copiado!)$/ })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(markdown);
    await dialog.getByRole('link', { name: 'Tabela anexa' }).click();
    await expect(dialog.locator('mark')).toHaveText('34\tExemplo');
    await copy.click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(tsv);
    await dialog.getByRole('button', { name: /^(Back|Voltar)$/ }).click();
    await expect(dialog.getByRole('heading', { name: 'Resultado' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(link).toBeFocused();
    await page.getByRole('link', { name: 'Arquivo movido' }).click();
    await expect(dialog.getByRole('alert')).toContainText(/não foi encontrado|not found/i);
    await expect(copy).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: 'Site de exemplo' }).click();
    expect(await page.evaluate(() => (window as any).openedWebsite)).toBe('https://example.org/');
    expect(page.url()).toBe(url);
    expect(context.pages()).toHaveLength(before);
  }
  expect(paths).toEqual(['docs/README.md', 'D:/project/docs/files/index.tsv', 'docs/README.md', 'missing.md',
    'docs/README.md', 'D:/project/docs/files/index.tsv', 'docs/README.md', 'missing.md']);
});

test('the file copy action stays visible while scrolling and identifies a partial preview', async ({ page }) => {
  const content = 'item\tvalor\n'.repeat(400) + 'último\t42';
  await page.route('**/linked-file?*', route => {
    const path = new URL(route.request().url()).searchParams.get('path')!;
    return route.fulfill({ json: { path, absolutePath: 'D:/project/' + path, projectId: null, worktreePath: null,
      content: path === 'large.tsv' ? content : '', isBinary: path === 'binary.dat', truncated: path === 'large.tsv' } });
  });
  await showTranscript(page, [{ role: 'assistant', content: [{ type: 'text', text: '[Grande](large.tsv) · [Vazio](empty.txt) · [Binário](binary.dat)' }] }],
    [{ id: 'file-actions', seq: 1, input_tokens: 1, output_tokens: 1 }]);
  await page.getByRole('link', { name: 'Grande' }).click();
  const dialog = page.getByRole('dialog');
  const copy = dialog.getByRole('button', { name: /^(Copy preview|Copiar prévia)$/ });
  const pane = dialog.locator('[data-linked-file-preview]');
  await expect(copy).toBeInViewport();
  await dialog.evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished)); });
  const buttonTop = await copy.evaluate(el => el.getBoundingClientRect().top);
  await pane.evaluate(el => { el.scrollTop = el.scrollHeight; });
  expect(await pane.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  expect(Math.abs(await copy.evaluate(el => el.getBoundingClientRect().top) - buttonTop)).toBeLessThan(1);
  await expect(copy).toBeInViewport();
  await copy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(content);
  await page.keyboard.press('Escape');
  for (const name of ['Vazio', 'Binário']) {
    await page.getByRole('link', { name }).click();
    await expect(pane).toContainText(/empty|vazio|formato|format/i);
    await expect(dialog.getByRole('button', { name: /copy|copiar/i })).toHaveCount(0);
    await page.keyboard.press('Escape');
  }
});

test('switching conversations dismisses a pending file and reads the new session on the next click', async ({ page }) => {
  let firstStarted!: () => void;
  const requested = new Promise<void>(resolve => { firstStarted = resolve; });
  let finishFirst!: () => void;
  const waitForReply = new Promise<void>(resolve => { finishFirst = resolve; });
  await page.route('**/linked-file?*', async route => {
    const second = route.request().url().includes('/fixture-two/');
    if (!second) { firstStarted(); await waitForReply; }
    await route.fulfill({ json: { path: 'README.md', absolutePath: 'D:/project/README.md', isBinary: false,
      projectId: 1, worktreePath: null, content: second ? 'Arquivo da conversa atual' : 'Leitura da conversa anterior' } });
  });
  await showTranscript(page, [{ role: 'assistant', content: [{ type: 'text', text: '[Relatório](README.md)' }] }],
    [{ id: 'links', seq: 1, input_tokens: 1, output_tokens: 1 }]);
  const link = page.getByRole('link', { name: 'Relatório' });
  const dialog = page.getByRole('dialog');
  await link.click();
  try {
    await requested;
    await expect(dialog.getByRole('status')).toBeVisible();
    await page.evaluate(() => (window as any).chatFixture.switch());
    await expect(dialog).toHaveCount(0);
    await link.click();
    await expect(dialog).toContainText('Arquivo da conversa atual');
  } finally { finishFirst(); }
  await expect(dialog).not.toContainText('Leitura da conversa anterior');
});

test('copying from a file modal can use the focused selection and reports a denied copy', async ({ page }) => {
  const content = '# Relatório\n\nUm **teste**.';
  await page.route('**/linked-file?*', route => route.fulfill({ json: {
    path: 'README.md', absolutePath: 'D:/project/README.md', projectId: 1, worktreePath: null,
    isBinary: false, truncated: false, content,
  } }));
  await showTranscript(page, [{ role: 'assistant', content: [{ type: 'text', text: '[Relatório](README.md)' }] }],
    [{ id: 'fallback', seq: 1, input_tokens: 1, output_tokens: 1 }]);
  await page.getByRole('link', { name: 'Relatório' }).click();
  const dialog = page.getByRole('dialog');
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 25));
      throw new DOMException('denied', 'NotAllowedError');
    };
    document.execCommand = command => {
      const target = document.activeElement;
      if (command !== 'copy' || !(target instanceof HTMLTextAreaElement) || !target.closest('[role="dialog"]')) return false;
      document.body.dataset.copiedSelection = target.value.slice(target.selectionStart, target.selectionEnd);
      return true;
    };
  });
  const copy = dialog.getByRole('button', { name: /^(Copy content|Copiar conteúdo)$/ });
  await copy.click();
  await expect(dialog.getByRole('button', { name: /^(Copied!|Copiado!)$/ })).toBeVisible();
  expect(await page.locator('body').getAttribute('data-copied-selection')).toBe(content);
  await page.evaluate(() => { document.execCommand = () => false; });
  await copy.click();
  await expect(dialog.getByRole('button', { name: /Copy failed|Falha ao copiar/i })).toBeVisible();
  await expect(dialog.locator('textarea')).toHaveCount(0);
});

test('processing stays below the latest activity through streaming and checkpoint replay, then clears on terminal events', async ({ page }) => {
  const request: PersistedMessage = { role: 'user', content: [{ type: 'text', text: 'Examinar o módulo' }] };
  const rows = [{ id: 'user', seq: 1, input_tokens: 0, output_tokens: 0 }];
  const tail = page.locator('[data-transcript-row-key^="tail:"]');
  const status = tail.locator('[role="status"]');
  const allLabels = page.getByText(/^(?:Processing|Processando)$/);
  await page.setViewportSize({ width: 420, height: 720 });
  await showTranscript(page, [request], rows, null, { streaming: true, preflight: { startedAt: Date.now() } });
  await expect(tail.getByText(/Analyzing the task|Analisando a tarefa/)).toBeVisible();
  await expect(allLabels).toHaveCount(0);

  await showTranscript(page, [request], rows, null, { streaming: true });
  await expect(status).toBeInViewport();
  await expect(allLabels).toHaveCount(1);

  const live: AssistantTurn = { blocks: [{ type: 'thinking', id: 'thinking', text: 'Conferindo a origem' },
    { type: 'usage', id: 'first', toolIds: ['read'], tokens: { input_tokens: 31, output_tokens: 4 } },
    { type: 'tool', call: { id: 'read', name: 'read_file', status: 'running', startedAt: Date.now() } }] };
  await showTranscript(page, [request], rows, live);
  await expect(page.locator('[data-turn-usage-trigger]')).toHaveCount(1);
  await expect(status).toBeVisible();
  await expect(page.locator('[data-turn-frame]').getByText(/^(?:Processing|Processando)$/)).toHaveCount(0);
  const text = 'Conferi o caminho do módulo.';
  live.blocks.push({ type: 'text', text });
  await showTranscript(page, [request], rows, live);
  const answer = page.getByText(text, { exact: true });
  await expect(answer).toBeVisible();
  await expect(allLabels).toHaveCount(1);
  const copy = tail.locator('[data-markdown-copy]');
  await expect(copy).toBeVisible();
  const bounds = (locator: Locator) => locator.evaluate(node => node.getBoundingClientRect().toJSON());
  await expect.poll(async () => (await bounds(status)).top - (await bounds(answer)).bottom).toBeGreaterThanOrEqual(0);
  expect((await bounds(status)).right).toBeLessThanOrEqual((await bounds(copy)).left);

  const stored: PersistedMessage[] = [request, { role: 'assistant', content: [{ type: 'text', text }] }];
  const committed = [...rows, { id: 'answer', operation_id: 'last:commit', seq: 2, input_tokens: 19, output_tokens: 5 }];
  const replay: AssistantTurn = { blocks: [{ type: 'text', text },
    { type: 'usage', id: 'last', toolIds: [], tokens: { input_tokens: 19, output_tokens: 5 } }] };
  await showTranscript(page, stored, committed, replay);
  await expect(page.locator('[data-transcript-row-key^="live:"]')).toHaveCount(0);
  await expect(status).toBeInViewport();
  for (const doneReason of ['end_turn', 'aborted', 'error']) {
    await showTranscript(page, stored, committed, replay, { streaming: false, doneReason,
      error: doneReason === 'error' ? 'Falha no fluxo de teste' : undefined });
    await expect(tail.locator('[data-run-finished]')).toHaveAttribute('data-run-finished', doneReason);
    await expect(allLabels).toHaveCount(0);
  }
  await expect(tail.getByRole('alert')).toContainText('Falha no fluxo de teste');
});

test('stream follows until upward intent, stays still while reading, and resumes explicitly', async ({ page }) => {
  const transcript = page.locator('.chat-transcript');
  await expect(transcript).toBeVisible();
  const bottomDistance = () => transcript.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
  await expect.poll(bottomDistance).toBeLessThan(10);
  const status = transcript.locator('[data-turn-footer] [role="status"]');
  await expect(status).toBeInViewport();
  await transcript.hover();
  // Tiny upward movements inside the old 8px threshold must also release follow.
  await page.mouse.wheel(0, -4);
  await expect(page.getByRole('button', { name: /latest|últim|fim|recent/i })).toBeVisible();
  const pinnedTop = await transcript.evaluate(el => el.scrollTop);
  await page.mouse.wheel(0, -500);
  await expect.poll(() => transcript.evaluate(el => el.scrollTop)).toBeLessThan(pinnedTop - 300);
  const before = await transcript.evaluate(el => el.scrollTop);
  const tick = Number(await page.locator('body').getAttribute('data-tick'));
  await expect.poll(async () => Number(await page.locator('body').getAttribute('data-tick'))).toBeGreaterThan(tick + 8);
  expect(Math.abs(await transcript.evaluate(el => el.scrollTop) - before)).toBeLessThan(3);
  await page.getByRole('button', { name: /latest|últim|fim|recent/i }).click();
  await expect.poll(bottomDistance).toBeLessThan(10);
  await expect(status).toBeInViewport();
  await page.mouse.wheel(0, -300);
  // wheel() returns before Chromium applies the scroll. Consume the old
  // session's gesture before testing the new session's follow reset.
  await expect.poll(bottomDistance).toBeGreaterThan(100);
  await page.evaluate(() => (window as any).chatFixture.switch());
  await expect.poll(bottomDistance).toBeLessThan(10);
});

test('tool/text blocks stay compact and 15 images open in a viewport-sized keyboard gallery', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => (window as any).chatFixture.short());
  await expect(page.getByText('Pergunta 40', { exact: true })).toHaveCount(0);
  const rows = page.locator('.chat-transcript [data-index]');
  await expect.poll(() => rows.count()).toBeGreaterThan(4);
  const gaps = await rows.evaluateAll(items => items.slice(0, -1).map((item, i) => {
    const current = item.getBoundingClientRect(); const next = items[i + 1]!.getBoundingClientRect();
    return next.top - current.bottom;
  }));
  expect(Math.max(...gaps)).toBeLessThan(12);
  await page.evaluate(() => (window as any).chatFixture.gallery());
  await expect(page.getByRole('button', { name: /Open image|Abrir imagem/ })).toHaveCount(15);
  await expect.poll(() => page.locator('.chat-transcript img').evaluateAll(images =>
    images.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await page.getByRole('button', { name: /(?:Open image|Abrir imagem) 1:/ }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(640);
  expect((await dialog.boundingBox())!.height).toBeGreaterThan(500);
  await page.keyboard.press('ArrowRight'); await expect(dialog).toContainText('Projeto 2.png');
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
  // Stored images use an explicit API origin; native <img> does not use the fetch interceptor.
  const encoded = await page.evaluate(() => (window as any).chatFixtureImage);
  await page.route('**/stored-api/api/coder/**/images/**', route => route.fulfill({ contentType: 'image/png', body: Buffer.from(encoded, 'base64') }));
  await page.evaluate(() => {
    (window as any).__MCP_API_BASE__ = `${location.origin}/stored-api`;
    (window as any).chatFixture.stored();
  });
  const firstThumbnail = page.locator('.chat-transcript img').first();
  await expect(firstThumbnail).toHaveAttribute('src', /stored-api\/api\/coder\/.*thumbnail=1/);
  await expect.poll(() => firstThumbnail.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(640);
  await page.getByRole('button', { name: /(?:Open image|Abrir imagem) 1:/ }).click();
  await expect(dialog.locator('img')).toHaveAttribute('src', /stored-api\/api\/coder\/.*\/images\/0$/);
  await expect.poll(() => dialog.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(640);
  expect(errors).toEqual([]);
});

test('long user messages keep a readable width with or without attachments after Markdown is virtualized', async ({ page }) => {
  const paragraphs = Array.from({ length: 120 }, (_, i) =>
    `Passo ${i + 1}: revisar o contrato de execução e os campos do tratamento. O conteúdo deve continuar legível e a imagem deve permanecer anexada à mensagem.`);
  const text = 'No histórico de execução agora tem nome do passo e nome do tratamento.\n\n' + paragraphs.join('\n\n');
  for (const width of [1440, 850, 420]) {
    await page.setViewportSize({ width, height: 900 });
    for (const imageCount of [0, 1, 3]) {
      await page.evaluate(args => (window as any).chatFixture.layout(args), { text, imageCount });
      const document = page.locator('[data-large-markdown]');
      await expect(document).toHaveAttribute('data-markdown-ready', 'true');
      await expect(page.locator('.chat-transcript img')).toHaveCount(imageCount);
      await expect.poll(() => document.evaluate(node => {
        const article = node.closest('article')!;
        return article.getBoundingClientRect().width / article.parentElement!.getBoundingClientRect().width;
      })).toBeGreaterThan(0.75);
      const viewport = document.locator('[data-markdown-viewport]');
      expect(await viewport.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThan(3);
      expect(await viewport.locator('[data-transcript-row-key]').count()).toBeLessThan(35);
      const article = page.locator('article').filter({ has: document });
      if (imageCount) {
        const bounds = await article.evaluate(node => ({
          right: node.getBoundingClientRect().right,
          imagesRight: Math.max(...Array.from(node.querySelectorAll('img')).map(image => image.closest('button')!.getBoundingClientRect().right)),
        }));
        expect(Math.abs(bounds.right - bounds.imagesRight)).toBeLessThan(2);
      }
      await viewport.evaluate(node => { node.scrollTop = node.scrollHeight; });
      await expect(viewport.getByText(paragraphs.at(-1)!, { exact: true })).toBeVisible();
    }
  }
});

test('short user messages and image-only turns retain their compact size', async ({ page }) => {
  for (const [text, imageCount] of [['Ok', 0], ['', 1]] as const) {
    await page.evaluate(args => (window as any).chatFixture.layout(args), { text, imageCount });
    await expect(page.locator('[data-large-markdown]')).toHaveCount(0);
    const article = page.locator('.chat-transcript article').first();
    await expect(page.locator('.chat-transcript img')).toHaveCount(imageCount);
    if (text) await expect(article.getByText(text, { exact: true })).toBeVisible();
    await expect(article).toBeVisible();
    expect((await article.boundingBox())!.width).toBeLessThan(imageCount ? 135 : 90);
  }
});

test('long replies keep copy below the edits and token details behind each turn icon on wide and narrow screens', async ({ page }) => {
  const intro = '**Primeira etapa**';
  const answer = Array.from({ length: 165 }, (_, i) => `Parágrafo ${i} com o caminho \`src/main.ts\` e a explicação completa do comportamento observado no editor.`).join('\n\n');
  const messages: PersistedMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'Verificar a conversa' }] },
    { role: 'assistant', content: [{ type: 'text', text: intro }, { type: 'tool_use', id: 'edit', name: 'edit_file', input: { path: 'src/main.ts' } }] },
    { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'private tool payload' }] },
    { role: 'assistant', content: [{ type: 'thinking', text: 'private reasoning' }, { type: 'text', text: answer }] },
  ];
  const rows = messages.map((_, i) => ({ id: `row-${i}`, seq: i + 1, input_tokens: [0, 123, 0, 987][i],
    output_tokens: [0, 34, 0, 56][i], cache_read_tokens: i === 1 ? 48 : 0, cache_creation_tokens: i === 3 ? 17 : 0 }));
  for (const width of [1280, 420]) {
    await page.setViewportSize({ width, height: 780 });
    await showTranscript(page, messages, rows);
    const icons = page.locator('[data-turn-usage-trigger]');
    const footer = page.locator('[data-turn-footer]').last();
    const copy = footer.locator('[data-markdown-copy]');
    await expect(page.locator('[data-large-markdown]')).toHaveAttribute('data-markdown-ready', 'true');
    await expect(icons).toHaveCount(2);
    await expect(page.locator('[data-turn-usage]')).toHaveCount(0);
    await expect(page.locator('[data-turn-footer] [data-markdown-copy]')).toHaveCount(1);
    await expect(page.locator('article [data-large-markdown] [data-markdown-copy]')).toHaveCount(0);
    await page.mouse.move(0, 0);
    await expect(copy).toBeInViewport();
    await expect(copy).toHaveCSS('opacity', '1');
    expect(await footer.evaluate(el => {
      const summary = el.previousElementSibling!;
      const box = el.getBoundingClientRect();
      return summary.tagName === 'DIV' && summary.querySelector('button') !== null
        && summary.getBoundingClientRect().bottom <= box.top + 1 && el.scrollWidth <= el.clientWidth + 1;
    })).toBe(true);
    expect(await page.locator('[data-user-actions]').evaluate(el =>
      el.previousElementSibling!.getBoundingClientRect().bottom <= el.getBoundingClientRect().top + 1)).toBe(true);
    await copy.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(intro + '\n\n' + answer);
    await checkTurnTokens(page, icons.first(), ['123', '34', '48']);
    await checkTurnTokens(page, icons.last(), ['987', '56', '17']);
  }
});

test('one border spans the live reasoning and its tool, and the icon works on hover, click and keyboard', async ({ page }) => {
  const live: AssistantTurn = { blocks: [
    { type: 'thinking', text: 'Checking the module paths' },
    { type: 'usage', id: 'reading', toolIds: ['read'], tokens: { input_tokens: 813, output_tokens: 28 } },
    { type: 'tool', call: { id: 'read', name: 'read_file', input: { path: 'a.ts' }, status: 'done', startedAt: 0,
      result: { content: 'ok', isError: false } } },
    { type: 'text', text: 'Writing the answer' },
  ] };
  await showTranscript(page, [], [], { blocks: live.blocks.filter(block => block.type !== 'usage') });
  const liveControls = page.locator('.chat-turn-frame[data-live] article button');
  await liveControls.first().click();
  await page.locator('[data-transcript-row-key$="tool:read"] article button').first().click();
  await expect(page.getByText('Checking the module paths')).toBeVisible();
  await showTranscript(page, [], [], live);
  const parts = page.locator('[data-turn-frame]');
  const trigger = page.locator('[data-turn-usage-trigger]');
  const details = page.locator('[data-turn-usage]');
  await expect(trigger).toHaveCount(1);
  await expect(parts).toHaveCount(2);
  await expect(parts.first()).toHaveAttribute('data-turn-start', 'true');
  await expect(parts.last()).toHaveAttribute('data-turn-end', 'true');
  await expect(parts.first()).toContainText('Checking the module paths');
  await expect(parts.last()).toContainText('a.ts');
  await expect(page.getByText('Writing the answer')).toBeVisible();
  expect(await parts.first().evaluate(el => {
    const frame = el.getBoundingClientRect();
    const icon = el.querySelector('button[data-turn-usage-trigger]')!.getBoundingClientRect();
    const article = el.querySelector('article')!.getBoundingClientRect();
    return Math.abs((icon.left + icon.right) / 2 - frame.left) < 2 && icon.right <= article.left;
  })).toBe(true);
  await expect.poll(async () => {
    const first = await parts.first().boundingBox();
    const last = await parts.last().boundingBox();
    return Math.abs(first!.y + first!.height - last!.y);
  }).toBeLessThan(2);
  await trigger.hover();
  await expect(details.locator('dd')).toHaveText(['813', '28']);
  await details.hover();
  await expect(details).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(details).toHaveCount(0);
  await trigger.click();
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => document.querySelector('[data-turn-usage]')?.getAnimations().every(a => a.playState === 'finished'));
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.getByText('Writing the answer').click();
  await expect(details).toHaveCount(0);
  await checkTurnTokens(page, trigger, ['813', '28']);
  await showTranscript(page, [], [], { blocks: [...live.blocks,
    { type: 'usage', id: 'writing', toolIds: [], tokens: { input_tokens: 503, output_tokens: 13 } }] });
  await expect(trigger).toHaveCount(2);
  await trigger.first().click();
  await trigger.last().hover();
  await expect(trigger.first()).toHaveAttribute('aria-expanded', 'false');
  await expect(details).toHaveCount(1);
  await expect(details.locator('dd')).toHaveText(['503', '13']);
});

test('live completion, reconnect and stored history show the same token counts once', async ({ page }) => {
  const messages: PersistedMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'Pergunta' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Etapa anterior' }] }];
  const tokens = { input_tokens: 427, output_tokens: 87 };
  const rows = [{ id: 'user', seq: 1, input_tokens: 0, output_tokens: 0 },
    { id: 'one', seq: 2, operation_id: 'first:commit', ...tokens }];
  const live: AssistantTurn = { startsMidTurn: true, blocks: [{ type: 'text', text: '**Segunda etapa**' },
    { type: 'usage', id: 'second', toolIds: [], tokens: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 31 } }] };
  await showTranscript(page, messages, rows, live);
  const icons = page.locator('[data-turn-usage-trigger]');
  await expect(icons).toHaveCount(2);
  await checkTurnTokens(page, icons.last(), ['0', '0', '31']);
  await expect(page.locator('[data-turn-footer] [data-markdown-copy]')).toHaveCount(1);
  messages.push({ role: 'assistant', content: [{ type: 'text', text: '**Segunda etapa**' }] });
  const committed = [...rows, { id: 'two', seq: 3, operation_id: 'second:commit', input_tokens: 0, output_tokens: 0, cache_read_tokens: 31 }];
  for (const replay of [live, null]) {
    await showTranscript(page, messages, committed, replay);
    await expect(icons).toHaveCount(2);
    await checkTurnTokens(page, icons.first(), ['427', '87']);
    await checkTurnTokens(page, icons.last(), ['0', '0', '31']);
    await expect(page.locator('[data-turn-footer] [data-markdown-copy]')).toHaveCount(1);
  }
});

test('copying a paged reply fetches its earlier Markdown only on click', async ({ page }) => {
  const cursors: string[] = [];
  await page.route('**/messages?*detail=assistant-text*', route => {
    const cursor = new URL(route.request().url()).searchParams.get('before_seq')!;
    cursors.push(cursor);
    return route.fulfill({ json: cursor === '133'
      ? { items: [{ seq: 50, text: 'Meio' }], next_before_seq: 33 }
      : { items: [{ seq: 3, text: 'Outra conversa' }, { seq: 6, text: '**Início**' }], next_before_seq: 5 } });
  });
  await showTranscript(page, [{ role: 'assistant', content: [{ type: 'text', text: 'Fim' }] }],
    [{ id: 'end', seq: 133, input_tokens: 0, output_tokens: 0 }], null, { precedingUser: 5 });
  await expect(page.locator('[data-turn-usage]')).toHaveCount(0);
  await expect(page.locator('[data-turn-usage-trigger]')).toHaveCount(0);
  const copy = page.locator('[data-turn-footer] [data-markdown-copy]');
  await expect(copy).toBeVisible();
  expect(cursors).toEqual([]);
  await copy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('**Início**\n\nMeio\n\nFim');
  expect(cursors).toEqual(['133', '33']);
});
