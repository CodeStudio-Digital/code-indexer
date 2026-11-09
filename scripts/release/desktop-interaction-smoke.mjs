/** Real Electron/Chromium regression: production guards, OS clipboard and xterm. No backend or user profile. */
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import react from '@vitejs/plugin-react';
import { _electron as electron } from 'playwright-core';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = process.cwd();
const out = resolve(root, '.tmp/desktop-interactions');
await mkdir(out, { recursive: true });
await build({ entryPoints: ['scripts/fixtures/desktop-interactions/main.ts'], bundle: true,
  platform: 'node', format: 'cjs', external: ['electron'], outfile: join(out, 'main.cjs') });
await copyFile('scripts/fixtures/desktop-interactions/preload.cjs', join(out, 'preload.cjs'));
const sourceCss = await readFile('apps/dashboard/index.css', 'utf8');
const selectionCss = sourceCss.slice(sourceCss.indexOf('/* Electron text-selection policy'), sourceCss.indexOf('/* ── AI-first'));
await writeFile(join(out, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>CodeStudio interaction test</title>
<style>body{padding:20px;font:16px sans-serif} #terminal,#output{height:130px;margin:12px 0} ${selectionCss}</style></head><body>
<div id="markdown"></div><div id="plain">ordinary status text</div><button id="copy">Copy</button><textarea id="input"></textarea>
<a id="web" href="https://example.org/plain">ordinary web link</a><a id="local" href="http://localhost:3000/plain">local link</a>
<a id="file" href="file:///C:/report.txt">file link</a><a id="route" href="#/projects/42">app route</a>
<div id="terminal"></div><div id="output"></div><script type="module" src="../../scripts/fixtures/desktop-interactions/renderer.tsx"></script></body></html>`);
await viteBuild({ configFile: false, root: out, base: './', plugins: [react()],
  build: { target: 'esnext', outDir: join(out, 'web'), emptyOutDir: true }, logLevel: 'warn' });
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({ executablePath: require('electron'), args: [join(out, 'main.cjs')], env });
const checks = [];
const errors = [];
const messages = [];
application.process().stderr?.on('data', data => messages.push(String(data)));
try {
  const page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') messages.push(message.text()); });
  await page.waitForLoadState('load');
  await page.waitForSelector('body[data-ready=true]');
  const originalUrl = page.url();
  const readClipboard = () => application.evaluate(({ clipboard }) => clipboard.readText());
  const waitClipboard = async value => {
    await page.waitForFunction(async expected => await navigator.clipboard.readText() === expected, value);
    assert.equal(await readClipboard(), value);
  };
  await page.locator('#copy').click(); await waitClipboard('copy button text'); checks.push('copy button');
  await page.locator('[data-code-copy]').click(); await waitClipboard('copy code block'); checks.push('chat code copy');
  await page.locator('#input').focus(); await page.keyboard.press('Control+V');
  assert.equal(await page.locator('#input').inputValue(), 'copy code block'); checks.push('native paste');
  await page.locator('#input').fill('editable copy'); await page.keyboard.press('Control+A'); await page.keyboard.press('Control+C');
  await waitClipboard('editable copy'); checks.push('native copy');
  await page.keyboard.press('Control+X'); assert.equal(await page.locator('#input').inputValue(), ''); checks.push('native cut');
  await page.evaluate(async () => {
    await window.interactionSmoke.editorClipboard.writeText('editor clipboard');
    if (await window.interactionSmoke.editorClipboard.readText() !== 'editor clipboard') throw new Error('editor clipboard mismatch');
  }); checks.push('editor clipboard service');
  for (const keys of ['Control+C', 'Control+Shift+C']) {
    await page.evaluate(() => { const t = window.interactionSmoke.terminal; t.focus(); t.select(0, 0, 22); });
    await page.keyboard.press(keys); await waitClipboard('terminal selected text');
    assert.deepEqual(await page.evaluate(() => window.interactionSmoke.input), []);
    checks.push(`terminal ${keys}`);
  }
  await page.evaluate(() => { const t = window.interactionSmoke.terminal; t.clearSelection(); t.focus(); });
  await page.keyboard.press('Control+C');
  assert.deepEqual(await page.evaluate(() => window.interactionSmoke.input), ['\u0003']); checks.push('SIGINT without selection');
  for (const keys of ['Control+V', 'Control+Shift+V', 'Shift+Insert']) {
    await application.evaluate(({ clipboard }) => clipboard.writeText('paste once'));
    await page.evaluate(() => { window.interactionSmoke.input.length = 0; window.interactionSmoke.terminal.focus(); });
    await page.keyboard.press(keys);
    await page.waitForFunction(() => window.interactionSmoke.input.length > 0);
    assert.equal(await page.evaluate(() => window.interactionSmoke.input.join('')), 'paste once'); checks.push(`terminal ${keys}`);
  }
  await page.evaluate(() => { const t = window.interactionSmoke.output; t.focus(); t.select(0, 0, 20); });
  await page.keyboard.press('Control+Shift+C'); await waitClipboard('output selected text'); checks.push('Output copy');
  await page.locator('#output').click({ button: 'right' }); await waitClipboard('output selected text'); checks.push('Output right-click copy');
  assert.equal(await page.locator('#plain').evaluate(el => getComputedStyle(el).userSelect), 'text');
  await page.locator('#plain').click(); await page.locator('#plain').selectText();
  await page.keyboard.press('Control+C'); await waitClipboard('ordinary status text'); checks.push('ordinary text selection');
  for (const [selector, url] of [['a:has-text("chat web")', 'https://example.org/chat'], ['a:has-text("chat local")', 'http://localhost:3000/chat'],
    ['#web', 'https://example.org/plain'], ['#local', 'http://localhost:3000/plain']]) {
    // Chromium cancels navigation in will-navigate. Playwright's actionability
    // tracker keeps that cancelled navigation pending; dispatch through the DOM
    // and assert the actual Electron URL and routed destination instead.
    await page.evaluate(selector => {
      const anchor = selector.startsWith('a:has-text')
        ? [...document.querySelectorAll('a')].find(a => a.textContent === selector.match(/"(.*?)"/)[1])
        : document.querySelector(selector);
      anchor.click();
    }, selector);
    await page.waitForTimeout(100);
    assert.equal(page.url(), originalUrl);
    assert.ok(await application.evaluate((_electron, target) => globalThis.interactionSmoke.external.includes(target), url));
    checks.push(`link ${url}`);
  }
  await page.evaluate(() => window.open('http://localhost:3000/popup', '_blank'));
  await page.waitForTimeout(100);
  assert.ok(await application.evaluate(() => globalThis.interactionSmoke.external.includes('http://localhost:3000/popup')));
  checks.push('local target=_blank');
  await page.evaluate(() => document.querySelector('#file').click()); await page.waitForTimeout(100);
  assert.equal(page.url(), originalUrl);
  assert.deepEqual(await application.evaluate(() => globalThis.interactionSmoke.documents), ['file:///C:/report.txt']); checks.push('document routed separately');
  await page.evaluate(() => document.querySelector('#route').click()); await page.waitForTimeout(100);
  assert.ok(page.url().endsWith('#/projects/42')); checks.push('app hash navigation');
  await page.screenshot({ path: join(out, 'validated.png') });
  assert.deepEqual(errors, []);
  await writeFile(join(out, 'report.json'), JSON.stringify({ ok: true, checks, rendererErrors: errors }, null, 2));
  console.log(JSON.stringify({ ok: true, checks: checks.length, report: join(out, 'report.json') }));
} catch (error) {
  await writeFile(join(out, 'report.json'), JSON.stringify({ ok: false, checks, error: String(error), errors, messages }, null, 2));
  console.error(JSON.stringify({ errors, messages }));
  throw error;
} finally { await application.close(); }
