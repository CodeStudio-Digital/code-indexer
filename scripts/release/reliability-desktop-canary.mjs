/** Full packaged application + real preload/IPC/backend, isolated disposable profile. */
import { chromium, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, createWriteStream, existsSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, join, relative, isAbsolute } from 'node:path';
import assert from 'node:assert/strict';

const output = resolve('.tmp/agent-ide-reliability', `desktop-canary-${Date.now()}`);
const projectRoot = join(output, 'project'); mkdirSync(projectRoot, { recursive: true });
// Give the fixture its own Git boundary: the workspace ignores .tmp, and its
// parent ignore rules must not silently exclude all of this test's sources.
assert.equal(spawnSync('git', ['init', '-q'], { cwd: projectRoot, windowsHide: true }).status, 0);
writeFileSync(join(projectRoot, 'CanaryPolicy.ts'), 'export function CanaryPolicy(now: number, expires: number) { return now >= expires; }\n');
let profile = join(output, 'profile');
const reuse = process.env.RELIABILITY_REUSE_PROFILE;
if (reuse) {
  const previous = realpathSync(resolve(reuse));
  const within = relative(realpathSync(resolve('.tmp/agent-ide-reliability')), previous);
  assert.ok(within && !within.startsWith('..') && !isAbsolute(within) && existsSync(join(previous, 'report.json')),
    'Only a recorded disposable canary profile can be reused');
  profile = join(previous, 'profile');
}
mkdirSync(profile, { recursive: true });
const chromiumProfile = join(output, 'chromium'); mkdirSync(chromiumProfile, { recursive: true });
const env = { ...process.env, MCP_DATA_DIR: profile, MCP_INDEX_DB: join(profile, 'index.db'), MCP_RUNTIME_COORDINATION_DIR: join(profile, 'coordination') };
delete env.ELECTRON_RUN_AS_NODE; delete env.MCP_ELECTRON_DEV_URL;
// Opt-in fixture uses the production offline identity cache, without changing
// the application bundle, injecting an auth handler, or copying real tokens.
const offlineUi = process.env.RELIABILITY_OFFLINE_UI === '1';
const fixtureAccount = { id: 'reliability-local-fixture', email: 'fixture@example.invalid', emailVerified: true, status: 'active' };
const accountPath = join(chromiumProfile, 'cloud', 'account.json');
const cloudRequests = [];
let cloudFixture;
if (offlineUi) {
  mkdirSync(join(chromiumProfile, 'cloud'), { recursive: true });
  writeFileSync(accountPath, JSON.stringify(fixtureAccount));
  cloudFixture = createServer((req, res) => {
    cloudRequests.push({ method: req.method, path: req.url });
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'unauthenticated', message: 'Offline local fixture has no cloud credentials.' }));
  });
  await new Promise(done => cloudFixture.listen(0, '127.0.0.1', done));
  env.CODESTUDIO_CLOUD_URL = `http://127.0.0.1:${cloudFixture.address().port}`;
  env.CODESTUDIO_PORTAL_URL = env.CODESTUDIO_CLOUD_URL;
}
const errors = [], results = [], owned = new Set();
const started = Date.now();
let startupMs;
let application, child, closed, page;
let failure;
try {
  child = spawn(resolve('.tmp/agent-ide-reliability/candidate/win-unpacked/CodeStudio.exe'),
    [`--user-data-dir=${chromiumProfile}`, '--disable-gpu', '--remote-debugging-port=0',
      ...(process.env.RELIABILITY_INSPECT ? ['--inspect=0'] : [])],
    { cwd: output, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const applicationLog = createWriteStream(join(output, 'application.log'));
  child.stdout.pipe(applicationLog, { end: false }); child.stderr.pipe(applicationLog, { end: false });
  closed = new Promise(done => child.once('exit', (code, signal) => { applicationLog.end(); done({ code, signal }); }));
  owned.add(child.pid);
  const endpoint = await new Promise((done, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('Application CDP startup timeout')), 60_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-32_768);
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); done(match[1]); }
    });
  });
  application = await chromium.connectOverCDP(endpoint);
  for (const context of application.contexts()) context.on('page', opened => {
    opened.on('console', message => { if (message.type() === 'error') console.error('Renderer console:', message.text()); });
    opened.on('pageerror', error => { errors.push(error.message); console.error('Renderer error:', error.message); });
  });
  console.log('Canary launched', child.pid, output);
  // Cold plugin installation and migration share the production startup budget.
  // Record actual latency; a functional pass must not imply a fast cold boot.
  const windowDeadline = Date.now() + 180_000;
  while (!page && Date.now() < windowDeadline) {
    page = application.contexts().flatMap(context => context.pages()).find(window => window.url().includes('dashboard/index.html'));
    if (!page) await new Promise(done => setTimeout(done, 100));
  }
  if (!page) console.error('Canary window diagnostics', application.contexts().flatMap(context => context.pages()).map(page => page.url()));
  assert.ok(page, 'Main dashboard must open');
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(30_000);
  startupMs = Date.now() - started;
  console.log('Canary renderer ready');
  page.on('pageerror', error => errors.push(error.message));
  console.log('Preload keys:', await page.evaluate(() => Object.keys(window.electronAPI ?? {})));
  await page.waitForFunction(() => typeof window.electronAPI?.invoke === 'function');
  if (offlineUi) {
    const auth = await page.evaluate(() => window.electronAPI.cloud.getAuthState());
    assert.equal(auth.state, 'logged_in');
    assert.equal(auth.account.id, fixtureAccount.id);
    assert.equal(existsSync(join(chromiumProfile, 'cloud', 'refresh.enc')), false);
    await page.addInitScript(() => {
      localStorage.setItem('mcp-ide:onboarded', 'true');
      localStorage.setItem('i18n-lang', 'en');
      localStorage.setItem('theme', 'dark');
    });
    await page.reload();
    await page.waitForFunction(() => typeof window.electronAPI?.invoke === 'function');
    results.push({ identity: 'synthetic offline cache', cloudAuthentication: 'not_tested', tokenStorePresent: false });
  }
  const invoke = async (method, payload) => {
    let timer;
    console.log('IPC start', method);
    const result = await Promise.race([
      page.evaluate(({ method, payload }) => window.electronAPI.invoke(method, payload), { method, payload }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`IPC timeout: ${method}`)), 30_000); }),
    ]).finally(() => clearTimeout(timer));
    if (!result.ok) throw new Error(`${method}: ${JSON.stringify(result.error)}`);
    console.log('IPC done', method);
    return result.value;
  };
  const existingProjects = await invoke('projects.list');
  assert.ok(Array.isArray(existingProjects));
  if (!reuse) assert.deepEqual(existingProjects, []);
  if (reuse) {
    const previous = existingProjects.find(project => project.name.startsWith('Reliability canary'));
    assert.ok(previous, 'Restart must retain the previous project');
    const retained = await invoke('files.searchPathsPage', { projectId: previous.id, query: 'CanaryPolicy', limit: 10 });
    assert.ok(retained.items.some(row => row.path === 'CanaryPolicy.ts'), 'Restart must retain the published index');
    results.push({ restart: 'preserved', previousProjectId: previous.id, retained });
  }
  const project = await invoke('projects.create', { name: `Reliability canary ${started}`, root_path: projectRoot });
  assert.ok(project.id);
  await invoke('projects.activate', { id: project.id, activationId: 'reliability-canary', clientId: 'reliability-canary' });
  const until = Date.now() + 60_000; let paths;
  do {
    paths = await invoke('files.searchPathsPage', { projectId: project.id, query: 'CanaryPolicy', limit: 10 });
    if (paths.items?.some(row => row.path === 'CanaryPolicy.ts')) break;
    await new Promise(done => setTimeout(done, 250));
  } while (Date.now() < until);
  if (!paths.items.some(row => row.path === 'CanaryPolicy.ts')) console.error('Index diagnostics', await invoke('projects.indexStatus', { id: project.id }), paths);
  assert.ok(paths.items.some(row => row.path === 'CanaryPolicy.ts'), 'IPC path index must contain the fixture');
  const before = await invoke('search.project', { projectId: project.id, query: 'CanaryPolicy', mode: 'fts', limit: 10 });
  assert.ok(before.results.length);
  await invoke('files.write', { projectId: project.id, path: 'CanaryNew.ts', content: 'export const CanaryNew = 73;\n' });
  const grep = await invoke('search.grep', { projectId: project.id, query: 'CanaryNew', regex: false, maxMatches: 20 });
  assert.ok(grep.files.some(file => file.path === 'CanaryNew.ts'));
  results.push({ projectId: project.id, indexedPaths: paths, searchHits: before.results.length, freshGrep: grep });
  const connectionId = 'draft:reliability-canary';
  await invoke('dbClient.connect', { spec: { connectionId, engine: 'sqlite', filePath: join(output, 'fixture.sqlite') } });
  await invoke('dbClient.query', { connectionId, sql: 'CREATE TABLE fixture(tenant INTEGER, id INTEGER, value TEXT, PRIMARY KEY(tenant,id))' });
  await invoke('dbClient.query', { connectionId, sql: "INSERT INTO fixture VALUES(1,1,'one'),(2,1,'two')" });
  const rows = await invoke('dbClient.query', { connectionId, sql: 'SELECT * FROM fixture ORDER BY tenant', maxRows: 1 });
  assert.equal(rows.rows.length, 1); assert.equal(rows.truncated, true); assert.equal(rows.timings.version, 1);
  const catalog = await invoke('dbClient.catalog', { connectionId, limit: 1 });
  results.push({ sqlitePage: rows, catalog });
  await invoke('dbClient.disconnect', { connectionId });
  await page.evaluate(id => { location.hash = `/projects/${id}`; }, project.id);
  await page.waitForTimeout(2500);
  if (offlineUi) {
    const { verifyDesktopUi } = await import('./reliability-desktop-ui.mjs');
    results.push(await verifyDesktopUi({ page, output, project, projectRoot, invoke }));
  }
  await page.screenshot({ path: join(output, 'desktop.png'), fullPage: true });
  if (offlineUi) {
    const denied = await page.evaluate(() => window.electronAPI.cloud.fetch('account.entitlements', undefined));
    assert.equal(denied.ok, false); assert.equal(denied.status, 401);
    await page.evaluate(() => window.electronAPI.cloud.logout());
    await expect(page.getByRole('button', { name: 'Continue with Google', exact: true })).toBeVisible();
    assert.equal((await page.evaluate(() => window.electronAPI.cloud.getAuthState())).state, 'logged_out');
    assert.equal(existsSync(join(chromiumProfile, 'cloud', 'refresh.enc')), false);
    await page.screenshot({ path: join(output, 'offline-logout.png'), fullPage: true });
    results.push({ cloudWithoutToken: '401', localLogoutRestoresGate: true, tokenStorePresent: false });
  }
  assert.deepEqual(errors, []);
  const cdp = await application.newBrowserCDPSession();
  for (const info of (await cdp.send('SystemInfo.getProcessInfo')).processInfo) owned.add(info.id);
  await cdp.detach();
  await invoke('projects.deactivate', { id: project.id, activationId: 'reliability-canary', clientId: 'reliability-canary' });
} catch (error) {
  failure = String(error); console.error('Canary failure:', error);
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
    const body = await page.locator('body').innerText().catch(() => 'unavailable');
    writeFileSync(join(output, 'failure-ui.txt'), body);
  }
  throw error;
} finally {
  if (page && !page.isClosed()) await page.evaluate(() => window.electronAPI?.windowControls.close()).catch(() => {});
  let timer;
  const exited = child ? await Promise.race([closed, new Promise(done => { timer = setTimeout(() => done(null), 30_000); })]) : null;
  clearTimeout(timer);
  const forced = !!child && child.exitCode === null;
  if (forced) {
    // Only the process launched above owns this disposable profile.
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    await closed;
  }
  await application?.close().catch(() => {});
  if (offlineUi) rmSync(accountPath, { force: true });
  if (cloudFixture) await new Promise(done => cloudFixture.close(done));
  await new Promise(done => setTimeout(done, 500));
  const remaining = [...owned].filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
  writeFileSync(join(output, 'report.json'), JSON.stringify({ at: new Date().toISOString(), output, profile, coldProfile: !reuse, offlineUi, cloudRequests, startupMs, results, errors, failure, exited, forced, ownedPids: [...owned], remaining }, null, 2));
  assert.deepEqual(remaining, []);
  if (!failure) assert.equal(forced, false, 'Successful canary must exit gracefully');
}
console.log(`PASS full desktop canary: ${output}`);
