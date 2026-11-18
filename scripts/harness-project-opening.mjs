// Real packaged Electron navigation with isolated project copies. Cloud auth is
// a local test fixture; project, SQLite, Git, indexing and IPC remain real.
// node scripts/harness-project-opening.mjs <executable> <fixture-manifest> <report-dir>
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { _electron as electron } from 'playwright-core';
const [executablePath, manifestPath, reportPath] = process.argv.slice(2).map(value => resolve(value));
const fixture = JSON.parse(await readFile(manifestPath, 'utf8'));
const output = reportPath;
await mkdir(output, { recursive: true });
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(MCP_|CODER_|ELECTRON_RUN_AS_NODE$)/.test(key) || /(?:API_KEY|ACCESS_TOKEN)$/.test(key)) delete env[key];
}
Object.assign(env, {
  MCP_DATA_DIR: join(fixture.output, 'data'), MCP_INDEX_DB: join(fixture.output, 'data/index.db'),
  MCP_MODEL_CACHE_DIR: join(fixture.output, 'models'), MCP_RUNTIME_COORDINATION_DIR: join(fixture.output, 'coordination'),
  DOTENV_CONFIG_PATH: join(fixture.output, 'absent.env'), MCP_DISABLE_TELEMETRY: '1',
  MCP_PROJECT_DB: '1', MCP_PROJECT_DB_NEW: '1', MCP_PROJECT_DB_ROUTE: '1', MCP_PROJECT_DB_SPLIT: '1',
  MCP_AUTO_INDEX_STRUCTURAL: '1', MCP_AUTO_WATCH: '1', MCP_DEV_HTTP: '0',
});
const report = { executablePath, startedAt: new Date().toISOString(), fixture: manifestPath,
  scope: 'Packaged Electron; consistent project DB copies + bounded source copies; real local IPC/Git/indexer; synthetic cloud auth',
  scenarios: [], errors: [], pids: [] };
let app, page;
try {
  for (let boot = 0; boot < 2; boot++) {
    const start = performance.now();
    app = await electron.launch({ executablePath, cwd: fixture.output, env, timeout: 90_000,
      args: ['--user-data-dir=' + join(output, 'profile')] });
    report.pids.push(app.process().pid);
    app.process().stderr?.on('data', data => {
      const text = data.toString();
      if (/Error|SQLITE|crash|failed/i.test(text)) report.errors.push({ source: 'stderr', text: text.slice(0, 1500) });
    });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      page = app.windows().find(p => /dashboard[\\/].*index\.html/.test(p.url()));
      if (page) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert(page, 'dashboard did not open');
    page.on('pageerror', error => report.errors.push({ source: 'renderer', text: error.message }));
    page.on('console', message => { if (message.type() === 'error') report.errors.push({ source: 'console', text: message.text().slice(0,1500) }); });
    page.on('requestfailed', request => report.errors.push({ source: 'request', text: request.url() + ' ' + request.failure()?.errorText }));
    // Only the cloud identity boundary is stubbed. No token is loaded or saved.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('cloud:auth-state');
      ipcMain.handle('cloud:auth-state', () => ({ state: 'logged_in', account: { id: 'local-fixture', email: 'fixture@example.invalid', name: 'Opening test' } }));
      ipcMain.removeHandler('cloud:fetch');
      ipcMain.handle('cloud:fetch', () => ({ ok: false, status: 503, body: { error: 'offline_test' } }));
      const probe = { gaps: [], previous: performance.now(), timer: null };
      probe.timer = setInterval(() => { const now = performance.now(); probe.gaps.push(Math.max(0, now - probe.previous - 20)); probe.previous = now; }, 20);
      globalThis.__projectOpenProbe = probe;
    });
    await page.evaluate(() => { localStorage.setItem('mcp-ide:onboarded', 'true'); localStorage.setItem('codestudio:preflight-done', 'true'); localStorage.setItem('theme', 'dark'); location.hash = '/'; });
    await page.reload();
    await page.waitForFunction(() => document.body.innerText.length > 100, undefined, { timeout: 30_000 });
    await page.evaluate(() => {
      const probe = { gaps: [], previous: performance.now(), frame: null };
      const frame = now => { probe.gaps.push(Math.max(0, now - probe.previous)); probe.previous = now; probe.frame = requestAnimationFrame(frame); };
      probe.frame = requestAnimationFrame(frame); globalThis.__projectFrameProbe = probe;
    });
    report['boot' + boot + 'Ms'] = performance.now() - start;
    // Three complete open/close cycles, plus one reopen after a process restart.
    for (let round = 0; round < (boot === 0 ? 3 : 1); round++) {
      for (const project of fixture.projects) {
        await page.evaluate(() => { location.hash = '/'; });
        await page.getByRole('button', { name: 'Files', exact: true }).waitFor({ state: 'hidden', timeout: 20_000 });
        await app.evaluate(() => { globalThis.__projectOpenProbe.gaps = []; globalThis.__projectOpenProbe.previous = performance.now(); });
        await page.evaluate(() => { globalThis.__projectFrameProbe.gaps = []; globalThis.__projectFrameProbe.previous = performance.now(); });
        const started = performance.now();
        await page.evaluate(id => { location.hash = '/projects/' + id; }, project.id);
        const files = page.getByRole('button', { name: 'Files', exact: true });
        await files.waitFor({ state: 'visible', timeout: 30_000 });
        const routeReadyMs = performance.now() - started;
        await files.click();
        await page.getByPlaceholder(/filter|filtrar/i).first().waitFor({ state: 'visible', timeout: 20_000 });
        const filesReadyMs = performance.now() - started;
        await page.getByRole('button', { name: 'Git', exact: true }).click();
        const git = await page.evaluate(async id => {
          const start = performance.now();
          const result = await window.electronAPI.invoke('projectGit.listRepos', { projectId: id });
          if (!result.ok) throw new Error(JSON.stringify(result.error));
          const first = result.value;
          return { elapsedMs: performance.now() - start, count: first.length, pending: first.some(r => r.discoveryPending) };
        }, project.id);
        await page.waitForTimeout(2000); // include background indexing and Git settlement
        const main = await app.evaluate(() => {
          const values = globalThis.__projectOpenProbe.gaps.slice().sort((a,b) => a-b);
          return { maxDelayMs: values.at(-1) ?? 0, p99DelayMs: values[Math.ceil(values.length*.99)-1] ?? 0, samples: values.length };
        });
        const renderer = await page.evaluate(() => {
          const values = globalThis.__projectFrameProbe.gaps.slice().sort((a,b) => a-b);
          return { maxFrameMs: values.at(-1) ?? 0, p95FrameMs: values[Math.ceil(values.length*.95)-1] ?? 0, samples: values.length };
        });
        const entry = { project: project.name, projectId: project.id, boot, round, routeReadyMs, filesReadyMs, git, main, renderer };
        report.scenarios.push(entry); console.log(JSON.stringify(entry));
        if (boot === 0 && round === 0) await page.screenshot({ path: join(output, 'project-' + project.id + '.png') });
        assert(main.maxDelayMs < 1000, 'main event-loop freeze: ' + JSON.stringify(entry));
        assert(routeReadyMs < 5000, 'project route took over 5s');
      }
    }
    report['diagnostics' + boot] = await page.evaluate(async () => {
      const results = {};
      for (const path of ['freezes', 'slow-ipc']) {
        const response = await fetch('mcp://app/api/admin/perf/' + path);
        results[path] = response.ok ? await response.json() : { status: response.status };
      }
      return results;
    });
    await app.close(); app = null; page = null;
  }
  assert(!report.errors.some(e => e.source === 'renderer'), 'renderer raised an exception');
  report.passed = true;
} catch (error) {
  report.failure = error.stack ?? String(error); process.exitCode = 1;
  if (page) { try { report.failureDiagnostics = await page.evaluate(async () => {
    const results = {};
    for (const [name, work] of [
      ['ipc', () => window.electronAPI.invoke('projects.get', { id: 1 })],
      ['http', () => fetch('mcp://app/api/projects/1', { signal: AbortSignal.timeout(3000) }).then(async r => ({ status: r.status, body: await r.text() }))],
    ]) { try { results[name] = await Promise.race([work(), new Promise(resolve => setTimeout(() => resolve('timeout'), 4000))]); } catch (e) { results[name] = String(e); } }
    return results;
  }); } catch {} }
  if (page) { try { report.body = (await page.locator('body').innerText()).slice(0, 6000); await page.screenshot({ path: join(output, 'failure.png') }); } catch {} }
} finally {
  if (app) await app.close();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, scenarios: report.scenarios.length, failure: report.failure, report: join(output, 'report.json') }));
}
