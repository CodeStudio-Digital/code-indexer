// node scripts/harness-renderer-performance.mjs [report.json]
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { chromium } from 'playwright-core';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = resolve(process.argv[2] ?? 'scratch/harness-renderer-performance.json');
const outDir = resolve(repo, 'scratch/harness-renderer-dist');
console.log('Building isolated renderer fixture');
await build({
  configFile: resolve(repo, 'apps/dashboard/vite.config.ts'), root: repo,
  build: { outDir, emptyOutDir: false, target: 'esnext',
    rollupOptions: { input: resolve(repo, 'scripts/harness-renderer/index.html') } },
  logLevel: 'error',
});
const server = await preview({ configFile: false, root: repo, build: { outDir },
  preview: { host: '127.0.0.1', port: 0, strictPort: false, open: false },
});
let browser;
try {
  console.log('Fixture server listening');
  const address = server.httpServer.address();
  assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  console.log('Chromium started');
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(30_000);
  await page.route('**/*', (route) => new URL(route.request().url()).origin === origin
    ? route.continue() : route.abort());
  await page.goto(`${origin}/scripts/harness-renderer/index.html`);
  console.log('Fixture loaded');
  await page.waitForFunction(() => typeof window.runHarnessStream === 'function');
  const transcript = page.locator('.chat-transcript');
  const rows = transcript.locator('[data-index]');
  await rows.first().waitFor();
  assert(await transcript.evaluate((element) => element.clientHeight < 720), 'fixture must constrain the scroll viewport');
  await transcript.hover();
  await page.mouse.wheel(0, -1000);
  await transcript.evaluate((element) => { element.scrollTop = 0; });
  await page.getByText('Synthetic block 0.', { exact: true }).waitFor();
  const topRows = await rows.count();
  assert(topRows < 80, `mounted ${topRows} rows of 5000 at the top`);
  await transcript.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.getByText('Synthetic block 4999.', { exact: true }).waitFor();
  const bottomRows = await rows.count();
  assert(bottomRows < 80, `mounted ${bottomRows} rows of 5000 at the bottom`);
  const stream = page.evaluate(() => window.runHarnessStream(120));
  const inputLatencies = [];
  for (let index = 0; index < 12; index++) {
    const started = performance.now();
    await page.getByLabel('Responsiveness probe').fill(`typing-${index}`);
    await page.waitForFunction((expected) => document.querySelector('[data-probe]')?.textContent === expected,
      `typing-${index}`);
    inputLatencies.push(performance.now() - started);
  }
  const frameTimes = await stream;
  await page.getByText('Synthetic block 4999. Streaming 119.', { exact: true }).waitFor();
  await transcript.hover();
  await page.mouse.wheel(0, -1000);
  await transcript.evaluate((element) => { element.scrollTop = 0; });
  await page.getByText('Synthetic block 0.', { exact: true }).waitFor();
  assert.deepEqual(errors, [], 'renderer exceptions');
  const stats = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { samples: values.length, p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maxMs: sorted.at(-1) };
  };
  const report = { synthetic: true, createdAt: new Date().toISOString(),
    chromium: browser.version(), viewport: '1280x720', blocks: 5_000,
    mountedRows: { top: topRows, bottom: bottomRows }, frameTimes: stats(frameTimes),
    inputRoundTrip: stats(inputLatencies), rendererErrors: errors,
    scope: 'MessageList isolated in Chromium; no Electron startup or installed application' };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
}
