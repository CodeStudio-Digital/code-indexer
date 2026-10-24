// Isolated startup trace of the complete desktop application; no provider calls.
// node scripts/harness-electron-startup.mjs [report-directory] [packaged-executable]
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] ?? 'scratch/harness-electron-startup');
await mkdir(output, { recursive: true });
const isolated = await mkdtemp(join(tmpdir(), 'codestudio-startup-'));
const executablePath = resolve(process.argv[3] ?? join(repo, 'node_modules/electron/dist/electron.exe'));
const packaged = Boolean(process.argv[3]);
const tracePath = join(output, 'startup-trace.json');
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (/^(MCP_|CODER_|ELECTRON_RUN_AS_NODE$)/.test(name) || /(?:API_KEY|ACCESS_TOKEN)$/.test(name)) delete env[name];
}
Object.assign(env, {
  MCP_DATA_DIR: join(isolated, 'data'), MCP_MODEL_CACHE_DIR: join(isolated, 'models'),
  MCP_INDEX_DB: join(isolated, 'data', 'index.db'),
  MCP_DISABLE_TELEMETRY: '1',
});
const started = performance.now();
let app;
const errors = [];
const report = { schemaVersion: 1, packaged, executablePath, isolated, tracePath,
  scope: 'Isolated empty-profile desktop startup; no provider or user-session access',
  startedAt: new Date().toISOString() };
try {
  app = await electron.launch({ executablePath, cwd: repo, env, timeout: 90_000,
    args: [...(packaged ? [] : [repo]), `--user-data-dir=${join(isolated, 'profile')}`,
      '--trace-startup=toplevel,devtools.timeline,v8,disabled-by-default-v8.cpu_profiler',
      '--trace-startup-duration=90', '--trace-startup-format=json',
      `--trace-startup-file=${tracePath}`,
      ],
  });
  report.launchMs = performance.now() - started;
  app.process().stderr?.on('data', () => {});
  app.context().on('page', page => page.on('pageerror', error => errors.push(error.message)));
  // The first window is the splash. Wait for the actual bundled dashboard.
  const deadline = Date.now() + 60_000;
  let dashboard;
  while (Date.now() < deadline) {
    dashboard = app.windows().find(page => /dashboard[\\/].*index\.html/.test(page.url()));
    if (dashboard) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(dashboard, 'dashboard did not open');
  await dashboard.waitForFunction(() => document.getElementById('root')?.childElementCount > 0, undefined, { timeout: 30_000 });
  report.dashboardMs = performance.now() - started;
  report.title = await dashboard.title();
  report.renderer = await dashboard.evaluate(async () => {
    const intervals = [];
    await new Promise(resolve => {
      let previous;
      const frame = now => {
        if (previous !== undefined) intervals.push(now - previous);
        previous = now;
        if (intervals.length < 120) requestAnimationFrame(frame); else resolve();
      };
      requestAnimationFrame(frame);
    });
    intervals.sort((a, b) => a - b);
    return { frames: intervals.length, frameP95Ms: intervals[Math.ceil(intervals.length * .95) - 1],
      frameMaxMs: intervals.at(-1), bodyLength: document.body.innerText.length };
  });
  // Chromium's --trace-startup recorder is independent of contentTracing's
  // session. Graceful application shutdown below flushes this recorder.
  report.errors = errors;
  assert.deepEqual(errors, [], 'desktop renderer exceptions');
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  report.elapsedMs = performance.now() - started;
  try {
    const trace = JSON.parse(await readFile(tracePath, 'utf8'));
    const events = trace.traceEvents ?? [];
    const names = new Map(events.filter(event => event.ph === 'M' && event.name === 'thread_name')
      .map(event => [`${event.pid}:${event.tid}`, event.args?.name]));
    report.longTasks = events.filter(event => event.ph === 'X' && event.dur >= 50_000)
      .sort((a, b) => b.dur - a.dur).slice(0, 25)
      .map(event => ({ name: event.name, durationMs: event.dur / 1000,
        thread: names.get(`${event.pid}:${event.tid}`), pid: event.pid, tid: event.tid }));
    report.traceEvents = events.length;
  } catch (error) { report.traceReadError = String(error); }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
