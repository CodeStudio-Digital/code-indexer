import { expect, test } from '@playwright/test';
import { fork, type ForkOptions } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdirSync, createWriteStream, writeFileSync } from 'node:fs';

type Query = { name: string; query: string; language: string; split: string };
type Reply = { id: number; error?: string; ms: number; result: {
  results: Array<{ data: { name?: string; file_path?: string; path?: string } }>;
  diagnostics: Record<string, unknown>;
} };

test('measures useful conceptual results from input to paint in a 10k-file project', async ({ page }, testInfo) => {
  test.setTimeout(1_800_000);
  const output = resolve('.tmp/agent-ide-reliability'); mkdirSync(output, { recursive: true });
  const variant = process.env.RELIABILITY_SEMANTIC_VARIANT ?? 'default';
  if (!/^[a-z0-9-]+$/.test(variant)) throw new Error('Invalid semantic variant');
  const log = createWriteStream(resolve(output, `semantic-ui-fixture-${variant}.txt`));
  const options: ForkOptions & { windowsHide: boolean } = {
    execPath: createRequire(import.meta.url)('electron'), execArgv: ['--import', 'tsx'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  };
  const child = fork(resolve('scripts/fixtures/semantic-search-benchmark.ts'), [], options);
  child.stdout!.pipe(log, { end: false }); child.stderr!.pipe(log, { end: false });
  const closed = new Promise<void>(done => child.once('exit', () => done()));
  const pending = new Map<number, (reply: Reply) => void>();
  let sequence = 0, notifyResponse: ((reply: Reply) => void) | undefined;
  try {
    const ready = await new Promise<{ manifest: object; queries: Query[] }>((done, reject) => {
      const timer = setTimeout(() => reject(new Error('Semantic fixture startup timeout')), 900_000);
      child.once('error', reject);
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Semantic fixture exited ${code}`)); });
      child.on('message', (message: Reply & { ready?: boolean; manifest: object; queries: Query[] }) => {
        if (message.ready) { clearTimeout(timer); done(message); }
        else { pending.get(message.id)?.(message); pending.delete(message.id); }
      });
    });
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()); let body: unknown = [];
      if (url.pathname.endsWith('/search')) {
        const id = ++sequence;
        const response = await new Promise<Reply>(done => {
          pending.set(id, done); child.send({ id, query: url.searchParams.get('q') });
        });
        body = response.error ? { results: [], diagnostics: { vectorError: response.error } } : response.result;
        await route.fulfill({ json: body }); notifyResponse?.(response); return;
      }
      if (url.pathname.endsWith('/file-paths')) body = { items: [], completeness: 'complete' };
      else if (url.pathname.endsWith('/file-tree')) body = { name: '.', path: '', type: 'dir', children: [] };
      else if (url.pathname.includes('git')) body = { files: [], notARepo: true };
      await route.fulfill({ json: body }).catch(() => undefined);
    });
    await page.goto('/e2e/fixtures/ide-search.html');
    await page.waitForFunction(() => typeof (window as unknown as { openSearch: unknown }).openSearch === 'function');
    await page.evaluate(() => (window as unknown as { openSearch(tab: string): void }).openSearch('semantic'));
    const input = page.getByRole('dialog').locator('input'); await expect(input).toBeVisible();
    const rows: Array<{ language: string; query: string; name: string; split: string; ms: number; backendMs: number; usefulAt10: boolean; diagnostics: object }> = [];
    for (const language of ['en', 'pt-BR']) {
      const queries = ready.queries.filter(q => q.language === language);
      for (let i = 0; i < 210; i++) {
        const query = queries[i % queries.length];
        await page.evaluate(() => {
          document.querySelector('[role=dialog] input')!.addEventListener('input', () => {
            (window as unknown as { inputStarted: number }).inputStarted = performance.now();
          }, { once: true });
        });
        const responsePromise = new Promise<Reply>(done => { notifyResponse = done; });
        await input.fill(query.query);
        const response = await responsePromise;
        if (response.error) throw new Error(response.error);
        const first = response.result.results[0];
        if (!first) throw new Error(`No conceptual result: ${query.query}`);
        const marker = first.data.name ?? first.data.file_path ?? first.data.path!;
        await page.waitForFunction(marker => document.querySelector('[role=dialog]')?.textContent?.includes(marker), marker);
        const ms = await page.evaluate(() => new Promise<number>(done => requestAnimationFrame(() => requestAnimationFrame(() => {
          done(performance.now() - (window as unknown as { inputStarted: number }).inputStarted);
        }))));
        if (i >= 10) rows.push({ ...query, ms, backendMs: response.ms,
          usefulAt10: response.result.results.slice(0, 10).some(hit => hit.data.name === query.name || (hit.data.file_path ?? hit.data.path) === `src/${query.name}.ts`),
          diagnostics: { ...response.result.diagnostics, hits: response.result.results.map(hit => hit.data) } });
        if (i % 25 === 0) console.log(`Semantic ${language}: ${i}/210, ${ms.toFixed(0)}ms`);
        writeFileSync(resolve(output, `ide-semantic-latency-${testInfo.project.name}-${variant}.json`), JSON.stringify({ manifest: ready.manifest,
          scope: 'production renderer + 400ms debounce + Playwright HTTP bridge + real hybrid/ONNX/vec0 + two frames; excludes application auth/IPC; result cache bypassed', rows }, null, 2));
      }
    }
    for (const language of ['en', 'pt-BR']) {
      const selected = rows.filter(row => row.language === language);
      const useful = selected.filter(row => row.usefulAt10).map(row => row.ms).sort((a, b) => a - b);
      expect(selected.filter(row => row.split === 'acceptance' && row.usefulAt10).length / selected.filter(row => row.split === 'acceptance').length).toBeGreaterThanOrEqual(.9);
      expect(useful[Math.ceil(useful.length * .95) - 1]).toBeLessThanOrEqual(1500);
    }
  } finally {
    if (child.connected) child.disconnect();
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 3000);
    await closed; clearTimeout(timer); log.end();
    expect(() => process.kill(child.pid!, 0)).toThrow();
  }
});
