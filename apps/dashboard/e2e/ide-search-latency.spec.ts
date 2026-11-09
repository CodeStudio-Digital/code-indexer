import { expect, test } from '@playwright/test';
import { fork, type ForkOptions } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

/** Production renderer + production SQLite path query in an owned Electron
 * child. HTTP is bridged by Playwright; full application IPC/auth is separate. */
test('measures input-to-painted path results at 10k and 150k files', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const childOptions: ForkOptions & { windowsHide: boolean } = {
    execPath: createRequire(import.meta.url)('electron'), execArgv: ['--import', 'tsx'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  };
  const child = fork(resolve('scripts/fixtures/path-search-benchmark.ts'), [], childOptions);
  const pid = child.pid;
  const closed = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const pending = new Map<number, (data: { items: { path: string }[]; sqlMs: number }) => void>();
  let sequence = 0, project = 1;
  const backendMs: number[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Path fixture startup timed out')), 30_000);
      child.once('error', reject);
      child.on('message', (data: { ready?: boolean; id: number; items: { path: string }[]; sqlMs: number }) => {
        if (data.ready) { clearTimeout(timeout); resolve(); }
        else { pending.get(data.id)?.(data); pending.delete(data.id); }
      });
    });
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      let body: unknown = [];
      if (url.pathname.endsWith('/file-paths')) {
        const id = ++sequence;
        const result = await new Promise<{ items: { path: string }[]; sqlMs: number }>(resolve => {
          pending.set(id, resolve);
          child.send({ id, projectId: project, query: url.searchParams.get('query') ?? '', limit: 50 });
        });
        backendMs.push(result.sqlMs);
        body = { items: result.items, source: 'structural_index', completeness: 'complete', revision: 'fixture:1' };
      } else if (url.pathname.endsWith('/file-tree')) body = { name: '.', path: '', type: 'dir', children: [] };
      else if (url.pathname.includes('git')) body = { files: [], notARepo: true, repoRoot: null };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => undefined);
    });
    await page.goto('/e2e/fixtures/ide-search.html');
    await page.waitForFunction(() => typeof (window as unknown as { openSearch: unknown }).openSearch === 'function');
    await page.evaluate(() => (window as unknown as { openSearch(): void }).openSearch());
    const input = page.getByRole('dialog').locator('input');
    await expect(input).toBeVisible();
    const results = [];
    for (const size of [10_000, 150_000]) {
      project = size === 10_000 ? 1 : 2;
      const timings: number[] = [];
      for (let index = 0; index < 210; index++) {
        const name = `Target${String(index).padStart(6, '0')}`;
        const path = `src/benchmark/${name}.tsx`;
        await page.evaluate(path => {
          const host = window as unknown as { sampleMs: number | null };
          host.sampleMs = null;
          const input = document.querySelector('[role=dialog] input')!;
          input.addEventListener('input', () => {
            const start = performance.now();
            const observer = new MutationObserver(() => {
              if (document.querySelector('[role=dialog]')?.textContent?.includes(path.split('/').pop()!)) {
                observer.disconnect();
                requestAnimationFrame(() => requestAnimationFrame(() => { host.sampleMs = performance.now() - start; }));
              }
            });
            observer.observe(document.body, { childList: true, subtree: true, characterData: true });
          }, { once: true });
        }, path);
        await input.fill(name);
        await page.waitForFunction(() => (window as unknown as { sampleMs: number | null }).sampleMs !== null, undefined, { timeout: 5000 });
        if (index >= 10) timings.push(await page.evaluate(() => (window as unknown as { sampleMs: number }).sampleMs));
      }
      timings.sort((a, b) => a - b);
      const p95Ms = timings[Math.ceil(timings.length * .95) - 1];
      results.push({ files: size, samples: timings.length, p50Ms: timings[99], p95Ms });
      expect(p95Ms).toBeLessThanOrEqual(size === 10_000 ? 250 : 500);
    }
    const output = resolve('.tmp/agent-ide-reliability'); mkdirSync(output, { recursive: true });
    writeFileSync(resolve(output, `ide-path-latency-${testInfo.project.name}.json`), JSON.stringify({ at: new Date().toISOString(), pid,
      scope: 'actual renderer input event + debounce + Playwright HTTP bridge + production SQLite query + two animation frames; excludes full app auth/IPC', results, backendMs }, null, 2));
  } finally {
    if (child.connected) child.disconnect();
    await Promise.race([closed, new Promise<void>(resolve => setTimeout(() => { if (child.exitCode === null) child.kill(); resolve(); }, 3000))]);
    await Promise.race([closed, new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`Owned fixture ${pid} did not exit`)), 3000))]);
  }
});
