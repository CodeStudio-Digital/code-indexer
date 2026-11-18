import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { _electron as electron, expect } from '@playwright/test';

const binary = resolve(process.argv[2] ?? 'dist/electron-builder/win-unpacked/CodeStudio Local.exe');
const root = await mkdtemp(join(tmpdir(), 'codestudio-local-smoke-'));
const project = join(root, 'project');
const profile = join(root, 'profile');
const data = join(root, 'data');
await mkdir(project);
execFileSync('git', ['init', '-b', 'main'], { cwd: project, stdio: 'ignore', windowsHide: true });
await writeFile(join(project, 'example.txt'), 'local file\n');

let cloudCalls = 0;
let modelCalls = 0;
const reply = 'Resposta do endpoint local.';
const server = createServer(async (req, res) => {
  if (req.url === '/ping') return res.end('local API response');
  if (req.url === '/v1/models') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ data: [{ id: 'local-test' }] }));
  }
  if (req.url === '/v1/chat/completions') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    if (request.model !== 'local-test') { res.writeHead(400); return res.end(); }
    modelCalls++;
    const choice = { index: 0, finish_reason: 'stop' };
    const usage = { prompt_tokens: 24, completion_tokens: 6, total_tokens: 30 };
    if (!request.stream) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ id: 'local-response', model: request.model, choices: [{ ...choice, message: { role: 'assistant', content: reply } }], usage }));
    }
    res.setHeader('content-type', 'text/event-stream');
    const chunk = { id: 'local-response', object: 'chat.completion.chunk', model: request.model, created: 1 };
    for (const payload of [
      { ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] },
      { ...chunk, choices: [{ ...choice, delta: {} }], usage },
    ]) res.write('data: ' + JSON.stringify(payload) + '\n\n');
    return res.end('data: [DONE]\n\n');
  }
  cloudCalls++;
  res.writeHead(503);
  res.end();
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const local = 'http://127.0.0.1:' + server.address().port;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|COMSPEC|PATHEXT|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(key)));
Object.assign(env, {
  MCP_DATA_DIR: data, MCP_MODEL_CACHE_DIR: join(root, 'models'),
  MCP_RUNTIME_COORDINATION_DIR: join(root, 'coordination'), PROVIDER_REFRESH_INTERVAL_MS: '0',
  CODESTUDIO_CLOUD_URL: local + '/unavailable', CODESTUDIO_PORTAL_URL: local + '/unavailable',
  MEGABRAIN_GITHUB_BROKER_URL: local + '/unavailable',
});
let app, page;
let passed = false;
const errors = [];
async function boot() {
  app = await electron.launch({ executablePath: binary, cwd: root, env, timeout: 90000,
    args: ['--user-data-dir=' + profile, '--disable-background-networking', '--disable-gpu'] });
  app.process().stderr?.resume();
  await expect.poll(() => app.windows().some(win => win.url().includes('/dashboard/index.html')), { timeout: 90000 }).toBe(true);
  page = app.windows().find(win => win.url().includes('/dashboard/index.html'));
  page.on('pageerror', error => { if (error.name !== 'Canceled') errors.push(error.message); });
  assert.equal(await app.evaluate(({ app }) => app.getName()), 'CodeStudio Local');
  assert.equal(await page.evaluate(() => typeof window.electronAPI?.cloud), 'undefined');
}
async function api(route, body) {
  return page.evaluate(async ({ route, body }) => {
    const res = await fetch('mcp://app/api/' + route, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw Error(route + ' (' + res.status + ') ' + (await res.text()).slice(0, 500));
    return res.json();
  }, { route, body });
}
async function ipc(name, input) {
  const response = await page.evaluate(({ name, input }) => window.electronAPI.invoke(name, input), { name, input });
  assert.equal(response.ok, true, JSON.stringify(response.error));
  return response.value;
}

try {
  await boot();
  await page.getByRole('button', { name: /^(Continue|Continuar)$/ }).click({ timeout: 60000 });
  await page.getByRole('button', { name: /^(Get started|Começar)$/ }).click();
  await page.getByRole('button', { name: /^(Skip for now|Pular por enquanto)$/ }).click();
  await page.getByPlaceholder('D:\\Projects\\my-app').fill(project);
  await page.getByRole('button', { name: /^(Open project|Abrir projeto)$/ }).click();
  await expect.poll(() => page.url(), { timeout: 60000 }).toMatch(/#\/projects\/\d+/);
  const projectId = Number(page.url().match(/#\/projects\/(\d+)/)[1]);
  const area = 'projects/' + projectId;
  assert.equal((await ipc('files.read', { projectId, path: 'example.txt' })).content, 'local file\n');
  assert.equal((await ipc('projectGit.status', { projectId })).branch, 'main');
  const collection = await api(area + '/api-client/collections', { name: 'Local collection' });
  const result = await api(area + '/api-client/send-adhoc', { request: { method: 'GET', path_template: local + '/ping' } });
  assert.equal(result.status, 200);
  assert.equal(result.body, 'local API response');
  const host = await api(area + '/ssh/hosts', { label: 'Local host', hostname: 'localhost', username: 'fixture', auth_method: 'agent' });
  await api('admin/providers', { id: 'local-test', name: 'Local endpoint', kind: 'openai',
    base_url: local + '/v1', enabled: true, use_for_coder: true });
  await api('admin/providers/local-test/models', { model_id: 'local-test', name: 'Local model', enabled: true, context_window: 128000 });
  const chat = await api('coder/sessions', { project_id: projectId, title: 'Local chat', provider: 'local-test', model: 'local-test' });
  const sessionPath = 'coder/sessions/' + chat.id;
  await api(sessionPath + '/messages', { content: 'Responda em uma frase.', response_mode: 'json', max_turns: 1 });
  await expect.poll(async () => JSON.stringify(await api(sessionPath + '/messages')), { timeout: 90000 }).toContain(reply);
  assert.ok(modelCalls > 0);
  await app.close();
  app = undefined;
  await boot();
  assert.ok((await api(area + '/api-client/collections')).collections.some(item => item.id === collection.id));
  assert.ok((await api(area + '/ssh/hosts')).hosts.some(item => item.id === host.id));
  assert.ok(JSON.stringify(await api(sessionPath + '/messages')).includes(reply));
  assert.equal(existsSync(join(profile, 'cloud', 'account.json')), false);
  assert.equal(cloudCalls, 0);
  assert.deepEqual(errors, []);
  passed = true;
  console.log(JSON.stringify({ cleanOnboarding: true, localFilesAndGit: true, apiRoundTrip: true, persistedSshHost: true,
    modelCalls, persistedReply: true, cloudCalls, rendererErrors: errors }));
} catch (error) {
  console.error('Isolated profile:', root);
  if (page && !page.isClosed()) {
    console.error((await page.locator('body').innerText().catch(() => '')).slice(-1500));
  }
  throw error;
} finally {
  await app?.close();
  await new Promise(done => server.close(done));
  if (passed && dirname(root) === resolve(tmpdir()) && basename(root).startsWith('codestudio-local-smoke-')) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
