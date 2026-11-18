// Real preview tools + Electron CDP, using an isolated profile and loopback-only page.
// Exercises the host preview implementation through Electron.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] ?? 'scratch/harness-electron-preview');
const executablePath = resolve(process.argv[3] ?? 'dist/electron-builder/win-unpacked/CodeStudio Local.exe');
const unpackaged = process.argv.includes('--unpackaged');
await mkdir(output, { recursive: true });
const isolated = await mkdtemp(join(tmpdir(), 'codestudio-preview-'));
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (/^(MCP_|CODER_|ELECTRON_RUN_AS_NODE$)/.test(name)
    || /(?:API_KEY|ACCESS_TOKEN)$/.test(name)) delete env[name];
}
Object.assign(env, {
  MCP_DATA_DIR: join(isolated, 'data'), MCP_MODEL_CACHE_DIR: join(isolated, 'models'),
  MCP_RUNTIME_COORDINATION_DIR: join(isolated, 'coordination'),
  MCP_INDEX_DB: join(isolated, 'data', 'index.db'), MCP_DISABLE_TELEMETRY: '1',
  PROVIDER_REFRESH_INTERVAL_MS: '0', CODER_PREFLIGHT: '0',
});
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Preview fixture</title>
<style>body{font:18px system-ui;padding:30px;background:#f4f7fb;color:#152037}button,input{font:inherit;padding:12px;margin:8px}#bottom{margin-top:1500px}</style>
<h1>Preview validation</h1><button id="button">Count action</button>
<label>Fixture value <input id="input" value="initial"></label><p id="status" role="status">Ready</p>
<div id="bottom">End of page</div><script>
window.events={click:0,double:0,right:0,enter:0,hover:0,input:0};
const button=document.querySelector('#button'),input=document.querySelector('#input');
button.addEventListener('click',()=>{events.click++;document.querySelector('#status').textContent='Clicked'});
button.addEventListener('dblclick',()=>events.double++);
button.addEventListener('contextmenu',e=>{e.preventDefault();events.right++});
button.addEventListener('mouseenter',()=>events.hover++);
input.addEventListener('keydown',e=>{if(e.key==='Enter')events.enter++});
input.addEventListener('input',()=>events.input++);
localStorage.setItem('fixture','local-value');sessionStorage.setItem('fixture','session-value');
localStorage.setItem('access_token','fixture-secret');
console.log('PREVIEW_FIXTURE_READY');fetch('/payload').then(r=>r.json()).then(v=>window.payload=v);
</script></html>`;
const server = createServer((request, response) => {
  if (request.url === '/payload') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ fixture: true }));
  } else {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html);
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
const report = {
  schemaVersion: 1, startedAt: new Date().toISOString(), executablePath, isolated,
  packaged: !unpackaged, scope: '22 first-party preview handlers through real Electron main/CDP; isolated loopback fixture; no provider calls',
  candidateSha256: await hashFile(unpackaged ? join(repo, 'dist/apps/electron/main.js') : join(dirname(executablePath), 'resources/app.asar')),
  errors: [],
};
let app;
let stderr = '';
try {
  const start = performance.now();
  app = await electron.launch({ executablePath, cwd: repo, env, timeout: 90_000,
    args: [...(unpackaged ? [repo] : []), `--user-data-dir=${join(isolated, 'profile')}`] });
  app.process().stderr?.on('data', data => { stderr = (stderr + data).slice(-64 * 1024); });
  let dashboard;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    dashboard = app.windows().find(page => /dashboard[\\/].*index\.html/.test(page.url()));
    if (dashboard) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(dashboard, 'Dashboard did not open');
  await dashboard.waitForFunction(() => document.querySelector('#root')?.childElementCount > 0);
  report.dashboardReadyMs = performance.now() - start;
  console.log('Packaged dashboard ready; exercising preview tools');
  report.preview = await app.evaluate(async ({ app, BrowserWindow }, { url, output, isolated }) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const assert = require('node:assert/strict');
    const { writeFile } = require('node:fs/promises');
    const { PreviewWindowService } = require(join(app.getAppPath(), 'dist/apps/electron/src/preview-window/service.js'));
    const { previewTools, getGlobalPreviewDevtools, setGlobalPreviewDevtools } = require(join(app.getAppPath(), 'dist/packages/code-agent/src/tools/preview/index.js'));
    const previous = getGlobalPreviewDevtools();
    const service = new PreviewWindowService();
    const ctx = { cwd: isolated, projectName: 'preview-fixture', sessionId: '7d96be9e-8c8c-4d49-83bd-6e8a768bf022' };
    const results = { calls: [], screenshot: join(output, 'preview.png') };
    const baselineWindows = new Set(BrowserWindow.getAllWindows().map(win => win.id));
    const invoke = async (name, args = {}, context = ctx) => {
      const tool = previewTools.find(tool => tool.name === name);
      assert(tool, `Missing tool: ${name}`);
      const start = performance.now();
      const result = await tool.handler(args, context);
      results.calls.push({ name, durationMs: performance.now() - start, isError: Boolean(result.isError),
        content: result.content.slice(0, 600) });
      assert(!result.isError, `${name}: ${result.content}`);
      return result;
    };
    setGlobalPreviewDevtools(service);
    try {
      await invoke('preview_open', { url, width: 900, height: 700 });
      const snapshot = await invoke('preview_snapshot', { interactiveOnly: true, limit: 20 });
      const button = snapshot.structuredData.nodes.find(node => node.role === 'button' && node.name === 'Count action');
      assert(button, 'Accessible button is missing');
      await invoke('preview_hover', { selector: `ref=${button.ref}` });
      await invoke('preview_click', { selector: `ref=${button.ref}` });
      await invoke('preview_wait_for', { selector: '#status', timeoutMs: 1000 });
      await invoke('preview_fill', { selector: '#input', value: 'hello' });
      await invoke('preview_type', { selector: '#input', text: ' world' });
      await invoke('preview_press', { selector: '#input', key: 'Enter' });
      await invoke('preview_double_click', { selector: '#button' });
      await invoke('preview_right_click', { selector: '#button' });
      const state = await invoke('preview_eval', { js: '({events:window.events,value:document.querySelector("#input").value,isolated:typeof window.electronAPI==="undefined"&&typeof window.require==="undefined"})' });
      results.observed = state.structuredData.value;
      assert.equal(results.observed.value, 'hello world');
      assert.equal(results.observed.events.double, 1);
      assert.equal(results.observed.events.right, 1);
      assert.equal(results.observed.events.enter, 1);
      assert(results.observed.events.click >= 1 && results.observed.events.hover >= 1 && results.observed.events.input >= 2);
      assert(results.observed.isolated, 'Preview exposed host APIs');
      const css = await invoke('preview_inspect_css', { selector: '#button' });
      assert(css.structuredData.computed?.computedStyle?.length, 'No computed CSS');
      const consoleOutput = await invoke('preview_console', { limit: 10 });
      assert(consoleOutput.content.includes('PREVIEW_FIXTURE_READY'));
      const network = await invoke('preview_network', { urlFilter: '/payload', includeBody: true, limit: 5 });
      assert(network.content.includes('fixture'));
      await invoke('preview_performance');
      const memory = await invoke('preview_memory');
      assert(memory.structuredData.memory.usedSize > 0);
      const storage = await invoke('preview_storage', { kind: 'local' });
      assert.equal(storage.structuredData.data.fixture, 'local-value');
      assert.equal(storage.structuredData.data.access_token, '[redacted]');
      await invoke('preview_scroll', { selector: '#bottom' });
      const scrolled = await invoke('preview_eval', { js: 'scrollY' });
      assert(scrolled.structuredData.value > 0);
      await invoke('preview_scroll', { selector: '#button' });
      await invoke('preview_viewport', { preset: 'mobile' });
      const screenshot = await invoke('preview_screenshot', { fullPage: false });
      const png = Buffer.from(screenshot.extraUserBlocks[0].base64, 'base64');
      assert.equal(png.subarray(1, 4).toString(), 'PNG');
      await writeFile(results.screenshot, png);
      results.screenshotBytes = png.length;
      await invoke('preview_navigate', { url: `${url}next` });
      const afterNavigation = await invoke('preview_snapshot');
      assert(afterNavigation.structuredData.page.url.endsWith('/next'));
      const controller = new AbortController();
      const waitTool = previewTools.find(tool => tool.name === 'preview_wait_for');
      const cancellationStarted = performance.now();
      const pending = waitTool.handler({ selector: '#never-exists', timeoutMs: 30_000 }, { ...ctx, signal: controller.signal });
      const timer = setTimeout(() => controller.abort(), 80);
      const cancelled = await pending.finally(() => clearTimeout(timer));
      results.cancelAckMs = performance.now() - cancellationStarted;
      assert(cancelled.isError, 'Wait did not acknowledge cancellation');
      assert(results.cancelAckMs < 2000, 'Cancellation waited for operation timeout');
      await invoke('preview_close');
      await service.closeAll();
      results.remainingPreviewWindows = BrowserWindow.getAllWindows().filter(win => !baselineWindows.has(win.id)).length;
      assert.equal(results.remainingPreviewWindows, 0);
      results.coveredTools = [...new Set(results.calls.map(call => call.name))].sort();
      assert.deepEqual(results.coveredTools, previewTools.map(tool => tool.name).sort());
      return results;
    } finally {
      await service.closeAll();
      setGlobalPreviewDevtools(previous);
      await writeFile(join(output, 'preview-calls.json'), JSON.stringify(results, null, 2));
    }
  }, { url, output, isolated });
  report.passed = true;
  console.log(`Preview passed: ${report.preview.coveredTools.length} tools; cancel ${report.preview.cancelAckMs.toFixed(1)}ms; no remaining preview windows`);
} catch (error) {
  report.passed = false;
  report.errors.push(String(error?.stack ?? error));
  process.exitCode = 1;
} finally {
  if (app) {
    report.applicationPids = await app.evaluate(({ app }) => app.getAppMetrics().map(metric => metric.pid)).catch(() => []);
    await app.close().catch(error => { report.errors.push(`close: ${error}`); report.passed = false; process.exitCode = 1; });
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const deadline = Date.now() + 5000;
    while (report.applicationPids.some(alive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    report.remainingApplicationPids = report.applicationPids.filter(alive);
    if (report.remainingApplicationPids.length) { report.passed = false; process.exitCode = 1; }
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(output, 'electron-stderr.txt'), stderr);
  console.log(JSON.stringify({ passed: report.passed, report: join(output, 'report.json'), errors: report.errors }, null, 2));
}
