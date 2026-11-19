import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import sharp from 'sharp';

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
let anthropicCalls = 0;
let figmaProviderCalls = 0;
let figmaSecretSeen = false;
let figmaVerificationNudges = 0;
const reply = 'Resposta do endpoint local.';
const anthropicReply = 'Resposta do endpoint Anthropic local.';
const figmaToken = 'figma-fixture-local-pat';
const figmaFile = 'https://www.figma.com/design/FixtureDesign1/Smoke';
const figmaFileName = 'Figma MCP fixture file';
const figmaReply = 'Figma MCP fixture validated.';
const figmaTool = 'ext_codestudio-figma__get_metadata';
const figmaShotTool = 'ext_codestudio-figma__get_screenshot';
const figmaShotFile = figmaFile + '?node-id=0-1';
const captureFigmaImage = 'Capture the Figma image fixture';
const reopenFigmaImage = 'Reopen the previous Figma image fixture';
const reopenedImageReply = 'Previous Figma attachment reopened.';
const missingImageReply = 'Previous Figma attachment unavailable.';
const figmaPng = await sharp({ create: { width: 96, height: 64, channels: 3, background: '#6366f1' } }).png().toBuffer();
const figmaPngBase64 = figmaPng.toString('base64');
const figmaImageId = createHash('sha256').update(JSON.stringify({ mediaType: 'image/png', base64: figmaPngBase64 })).digest('hex').slice(0, 24);

function figmaFixtureReply(request, currentPrompt) {
  const sawToolResult = predicate => request.messages.some(message => message.role === 'tool' && predicate(JSON.stringify(message.content)));
  if (currentPrompt.includes(reopenFigmaImage)) {
    if (sawToolResult(text => text.includes('original 96×64') && text.includes(figmaImageId))) return { text: reopenedImageReply };
    if (sawToolResult(text => /Image reference not found|view_image:/.test(text))) return { text: missingImageReply };
    return { call: { name: 'view_image', input: { attachment_id: figmaImageId } } };
  }
  const screenshot = currentPrompt.includes(captureFigmaImage);
  if (sawToolResult(text => screenshot ? text.includes('FixtureDesign1') && text.includes('0:1') && text.includes('png') : text.includes(figmaFileName))) {
    return { text: figmaReply };
  }
  const toolName = screenshot ? figmaShotTool : figmaTool;
  const hasSchema = request.tools?.some(tool => tool.function?.name === toolName);
  if (!hasSchema && !sawToolResult(text => text.includes(toolName))) {
    return { call: { name: 'find_tools', input: { query: `codestudio figma ${screenshot ? 'get_screenshot' : 'get_metadata'}` } } };
  }
  const alias = toolName.replaceAll('-', '_');
  const file = JSON.stringify(screenshot ? figmaShotFile : figmaFile);
  return { call: { name: 'code_exec', input: { code: `return await tools.${alias}({file:${file}});` } } };
}

const server = createServer(async (req, res) => {
  if (req.url === '/ping') return res.end('local API response');
  if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (req.url === '/page') {
    res.setHeader('content-type', 'text/html');
    return res.end('<title>Local Chromium</title><main></main><script>document.querySelector("main").textContent="Rendered by Chromium"</script>');
  }
  if (req.url === '/v1/models') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ data: [{ id: 'local-test' }] }));
  }
  if (req.url === '/v1/chat/completions') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    if (request.model !== 'local-test') { res.writeHead(400); return res.end(); }
    if (raw.includes(figmaToken)) figmaSecretSeen = true;
    const figmaPrompt = request.messages?.filter(message => message.role === 'user')
      .map(message => JSON.stringify(message.content))
      .findLast(text => text?.includes(figmaFile) || text?.includes(reopenFigmaImage));
    if (request.stream && figmaPrompt) {
      figmaProviderCalls++;
      if (request.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('[verification-required]'))) {
        figmaVerificationNudges++;
      }
      const { text, call } = figmaFixtureReply(request, figmaPrompt);
      const delta = text ? { role: 'assistant', content: text } : {
        role: 'assistant',
        tool_calls: [{ index: 0, id: 'figma-call-' + figmaProviderCalls, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.input) } }],
      };
      const chunk = { id: 'figma-msg', object: 'chat.completion.chunk', model: request.model, created: 1 };
      res.setHeader('content-type', 'text/event-stream');
      for (const payload of [
        { ...chunk, choices: [{ index: 0, delta, finish_reason: null }] },
        { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: text ? 'stop' : 'tool_calls' }],
          usage: { prompt_tokens: 45, completion_tokens: 8, total_tokens: 53 } },
      ]) res.write('data: ' + JSON.stringify(payload) + '\n\n');
      return res.end('data: [DONE]\n\n');
    }
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
  if (req.url === '/v1/messages') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    if (request.model !== 'local-test' || req.headers['x-api-key'] !== 'local-fixture') {
      res.writeHead(400);
      return res.end();
    }
    anthropicCalls++;
    res.setHeader('content-type', 'text/event-stream');
    for (const event of [
      { type: 'message_start', message: { id: 'msg-local', type: 'message', role: 'assistant', model: request.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: anthropicReply } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ]) res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
    return res.end();
  }
  cloudCalls++;
  res.writeHead(503);
  res.end();
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const local = 'http://127.0.0.1:' + server.address().port;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|COMSPEC|PATHEXT|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(key)));
// Copilot's native runtime cache is also scoped to the smoke profile.
await mkdir(join(root, 'local-app-data'));
Object.assign(env, {
  LOCALAPPDATA: join(root, 'local-app-data'),
  MCP_DATA_DIR: data, MCP_MODEL_CACHE_DIR: join(root, 'models'), MODEL_PRICING_REMOTE_ENABLED: '0',
  MCP_RUNTIME_COORDINATION_DIR: join(root, 'coordination'), PROVIDER_REFRESH_INTERVAL_MS: '0',
  COPILOT_DISABLE_KEYTAR: '1', // The isolated smoke never reads or writes credentials in the user's vault.
  CODESTUDIO_CLOUD_URL: local + '/unavailable', CODESTUDIO_PORTAL_URL: local + '/unavailable',
  MEGABRAIN_GITHUB_BROKER_URL: local + '/unavailable',
});
let app, page;
let passed = false;
const errors = [];
let electronStderr = '';
let electronLogs = '';
async function boot() {
  app = await electron.launch({ executablePath: binary, cwd: root, env, timeout: 90000,
    args: ['--user-data-dir=' + profile, '--disable-background-networking', '--disable-gpu'] });
  app.process().stderr?.on('data', data => {
    electronStderr = (electronStderr + data.toString()).slice(-8000);
  });
  app.process().stdout?.on('data', data => {
    electronLogs = (electronLogs + data.toString()).slice(-8000);
  });
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

async function assertProviderSurface() {
  const kinds = ['anthropic', 'bedrock', 'copilot', 'openai'];
  assert.deepEqual((await api('admin/providers/known')).map(item => item.kind).sort(), kinds);
  assert.deepEqual((await api('admin/providers')).providers.map(item => item.kind).sort(), kinds);
  const retired = await page.evaluate(async () => {
    const base = 'mcp://app/api/admin/';
    const status = route => fetch(base + route).then(res => res.status);
    const create = kind => fetch(base + 'providers', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: kind, kind, name: kind }),
    }).then(res => res.status);
    return Promise.all([status('chrome-service'), create('chatgpt'), create('gemini')]);
  });
  assert.deepEqual(retired, [404, 400, 400]);
  assert.deepEqual((await ipc('system.preflight')).checks.map(check => check.id).sort(), ['disk', 'git']);
  const bundled = await readdir(join(dirname(binary), 'resources', 'bundled-plugins'), { withFileTypes: true });
  assert.deepEqual(bundled.filter(entry => entry.isDirectory()).map(entry => entry.name).sort(),
    ['angular', 'figma', 'javascript-debugger']);
}

async function exerciseElectronChromium() {
  const result = await app.evaluate(async ({ app }, local) => {
    const { join } = process.getBuiltinModule('node:path');
    const { createRequire } = process.getBuiltinModule('node:module');
    const require = createRequire(join(app.getAppPath(), 'package.json'));
    const { createElectronBrowserHost } = require('./dist/apps/electron/src/browser-context-host.js');
    const { BrowserBackend } = require('./dist/packages/services/src/services/docs/render-backend.js');
    const host = createElectronBrowserHost();
    try {
      const renderer = new BrowserBackend(async () => host);
      const result = await renderer.render(local + '/page');
      return { via: result.via, status: result.status, html: result.html };
    } finally {
      await host.dispose();
    }
  }, local);
  assert.equal(result.via, 'browser');
  assert.equal(result.status, 200);
  assert.ok(result.html.includes('<main>Rendered by Chromium</main>'));
}

async function exerciseCopilotRuntime() {
  const result = await app.evaluate(({ app }, baseUrl) => {
    const { join } = process.getBuiltinModule('node:path');
    const { Worker } = process.getBuiltinModule('node:worker_threads');
    const entry = join(app.getAppPath(), 'dist/packages/code-agent/src/providers/copilot-sdk-client.js');
    const script = 'const run = ' + String(async function run({ entry, baseUrl }) {
      const { pathToFileURL } = process.getBuiltinModule('node:url');
      const { createCopilotSession, startCopilotClient, stopCopilotClient } = await import(pathToFileURL(entry).href);
      const client = await startCopilotClient('release-smoke');
      try {
        const session = await createCopilotSession(client, {
          model: 'fixture/local-test',
          inference: {
            providers: [{ name: 'fixture', type: 'openai', baseUrl, apiKey: 'local-fixture', wireApi: 'completions' }],
            models: [{ provider: 'fixture', id: 'local-test', modelId: 'gpt-4o' }],
          },
          tools: { availableTools: [] },
          github: { telemetryEnabled: false, capi: { enabled: false } },
        });
        try { return typeof session.rpc.accounts.login.begin; }
        finally { await client.deleteSession(session.sessionId); }
      } finally {
        await stopCopilotClient(client);
      }
    }) + `;
      import { parentPort, workerData } from 'node:worker_threads';
      run(workerData).then(value => parentPort.postMessage({ value }),
        error => parentPort.postMessage({ error: error.message }));
    `;
    const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(script)), { workerData: { entry, baseUrl } });
    return new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', code => reject(new Error('Copilot test worker exited with ' + code)));
      worker.once('message', ({ value, error }) => {
        if (error) reject(new Error(error));
        else resolve(value);
      });
    });
  }, local + '/v1');
  assert.equal(result, 'function');
}

async function exerciseCopilotLogin() {
  const fixtureFile = join(root, 'copilot-login-fixture.cjs');
  await writeFile(fixtureFile, 'module.exports = ' + String(async function installFixture(appPath) {
    const { join } = require('node:path');
    const { pathToFileURL } = require('node:url');
    const entry = join(appPath, 'node_modules', '@microsoft', 'copilot-sdk', 'dist', 'index.js');
    const { CopilotClient } = await import(pathToFileURL(entry).href);
    const prototype = CopilotClient.prototype;
    const state = { steps: 0 };
    let quotaRemaining = 549.75;
    let allowAccountChoice;
    const deviceInspected = new Promise(resolve => { allowAccountChoice = resolve; });
    const methods = {
      async start() {
        state.mode = this.options.mode;
        Object.defineProperty(this, 'rpc', { value: { account: {
          async getQuota() { return { quotaSnapshots: {} }; },
          async getCurrentAuth() {
            return { authInfo: { type: 'user', copilotUser: {
              login: 'chosen-fixture', token_based_billing: true,
              quota_snapshots: { premium_interactions: { entitlement: 1000, quota_remaining: quotaRemaining } },
            } } };
          },
        } } });
      },
      async stop() {},
      async deleteSession() {},
      async getAuthStatus() { return { isAuthenticated: true, login: 'chosen-fixture', host: 'https://github.com' }; },
      async listModels() {
        return [{ id: 'fixture-copilot-model', name: 'Fixture Copilot Model', capabilities: { supports: {} } }];
      },
      async createSession(options) {
        state.usesHostTools = options.enableConfigDiscovery === false && options.tools.availableTools.length === 0
          && options.tools.excludedTools.includes('builtin:*') && options.tools.excludedTools.includes('mcp:*');
        return { sessionId: 'fixture-copilot-session', rpc: {
          options: { async update(patch) { state.clearedPlugins = patch.plugins.installed.length === 0; } },
          accounts: { login: {
            async begin() {
              return { flowId: 'fixture-copilot-flow', step: {
                kind: 'device-code', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device',
                expiresIn: 900, interval: 1,
              } };
            },
            async advance({ input }) {
              state.steps++;
              if (state.steps === 1) return { kind: 'awaiting' };
              if (!input) {
                await deviceInspected;
                return { kind: 'completed', result: { status: 'needs-account-selection', accounts: [
                  { selectionId: 'first', login: 'first-fixture', host: 'github.com' },
                  { selectionId: 'chosen', login: 'chosen-fixture', host: 'github.com' },
                ] } };
              }
              state.choice = input;
              return { kind: 'completed', result: { status: 'completed', login: 'chosen-fixture', host: 'github.com' } };
            },
            async cancel() {},
          } },
        } };
      },
    };
    const originals = Object.fromEntries(Object.keys(methods).map(key => [key, prototype[key]]));
    Object.assign(prototype, methods);
    globalThis.copilotLoginFixture = {
      state, allowAccountChoice,
      setQuotaRemaining: value => { quotaRemaining = value; },
      restore: () => Object.assign(prototype, originals),
    };
  }));

  await app.evaluate(async ({ app }, fixtureFile) => {
    const require = process.getBuiltinModule('node:module').createRequire(fixtureFile);
    await require(fixtureFile)(app.getAppPath());
  }, fixtureFile);
  try {
    const projectHash = await page.evaluate(() => location.hash);
    await page.evaluate(() => { location.hash = '#/admin'; });
    await page.getByRole('button', { name: /^(Conectar|Connect)$/ }).first().click({ timeout: 30000 });
    await page.getByRole('menuitem', { name: /^(Conectar|Connect) Copilot$/ }).click();
    const dialog = page.getByRole('dialog', { name: /^(Conectar|Connect) GitHub Copilot$/ });
    await dialog.getByRole('button', { name: 'Individual / Business' }).click();
    await expect(dialog.getByText('ABCD-EFGH')).toBeVisible();
    await app.evaluate(() => { globalThis.copilotLoginFixture.allowAccountChoice(); });
    await dialog.getByRole('button', { name: 'chosen-fixture · github.com' }).click();
    await expect(dialog).toBeHidden();
    assert.deepEqual(await app.evaluate(() => globalThis.copilotLoginFixture.state),
      { mode: 'coding-agent', steps: 3, usesHostTools: true, clearedPlugins: true, choice: 'chosen' });
    const { providers } = await api('admin/providers');
    assert.equal(providers.find(provider => provider.id === 'copilot').extra.githubLogin, 'chosen-fixture');
    const { models } = await api('admin/providers/copilot/models');
    assert.ok(models.some(model => model.model_id === 'fixture-copilot-model'));
    const quota = page.getByRole('region', { name: /^(Cota do Copilot|Copilot quota)$/ });
    await quota.getByRole('button', { name: /^(Consultar cota|Check quota)$/ }).click();
    await expect(quota.getByText(/^(Créditos de IA|AI credits)$/)).toBeVisible();
    await expect(quota.getByText(/^549[.,]75$/)).toBeVisible();

    const projectId = Number(projectHash.match(/^#\/projects\/(\d+)/)[1]);
    const chat = await api('coder/sessions', {
      project_id: projectId, title: 'Quota shortcut fixture', provider: 'copilot', model: 'fixture-copilot-model',
    });
    const chatHash = `#/projects/${projectId}?session=${encodeURIComponent(chat.id)}`;
    await page.evaluate(hash => { location.hash = hash; }, chatHash);
    const shortcut = page.getByRole('button', { name: /^(Cotas de uso|Usage quotas)$/ });
    await shortcut.click({ timeout: 30000 });
    const quickQuota = page.getByRole('region', { name: 'GitHub Copilot', exact: true });
    await expect(shortcut).toHaveAttribute('aria-pressed', 'true');
    await expect(quickQuota.getByText(/^549[.,]75$/)).toBeVisible({ timeout: 15000 });
    await app.evaluate(() => { globalThis.copilotLoginFixture.setQuotaRemaining(537.25); });
    await quickQuota.getByRole('button', { name: /^(Atualizar cota|Refresh quota)$/ }).click();
    await expect(quickQuota.getByText(/^537[.,]25$/)).toBeVisible();
    await shortcut.click();
    await expect(quickQuota).toBeHidden();
    await page.evaluate(hash => { location.hash = hash; }, projectHash);
    await expect.poll(() => page.url()).toMatch(/#\/projects\/\d+/);
  } finally {
    await app.evaluate(() => {
      globalThis.copilotLoginFixture.allowAccountChoice();
      globalThis.copilotLoginFixture.restore();
    });
  }
}

async function stubFigma(rateLimited = false) {
  await app.evaluate((_electron, { token, fileName, rateLimited, png }) => {
    const fetch = globalThis.fetch;
    globalThis.figmaMetadataReads = 0;
    globalThis.figmaImageReads = 0;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.href === 'https://assets.figma.com/codestudio-fixture.png') {
        globalThis.figmaImageReads++;
        if (rateLimited) return Response.json({}, { status: 403 });
        return new Response(new Uint8Array(Buffer.from(png, 'base64')), { headers: { 'Content-Type': 'image/png' } });
      }
      if (url.hostname !== 'api.figma.com') return fetch(input, init);
      if (new Headers(init?.headers).get('X-Figma-Token') !== token) return Response.json({}, { status: 403 });
      if (url.pathname === '/v1/me') return Response.json({ id: 'fixture-account', handle: 'Figma Fixture' });
      if (url.pathname === '/v1/images/FixtureDesign1') {
        if (rateLimited) return Response.json({}, { status: 429 });
        return Response.json({ images: { '0:1': 'https://assets.figma.com/codestudio-fixture.png' } });
      }
      if (url.pathname === '/v1/files/FixtureDesign1') {
        globalThis.figmaMetadataReads++;
        if (rateLimited) return Response.json({}, { status: 429, headers: { 'Retry-After': '45' } });
        return Response.json({ name: fileName, document: {
          id: '0:0', children: [{ id: '0:1', type: 'CANVAS', name: 'Overview' }],
        } });
      }
      return Response.json({}, { status: 404 });
    };
  }, { token: figmaToken, fileName: figmaFileName, rateLimited, png: figmaPngBase64 });
}

async function exerciseFigmaPanel() {
  const plugin = await ipc('plugins.get', { namespace: 'figma' });
  assert.equal(plugin?.enabled, true);
  await page.evaluate(() => { location.hash = location.hash.split('?')[0] + '?tab=figma'; });
  const panel = page.frameLocator('iframe[title="plugin:figma:Figma"]');
  await panel.getByLabel(/^(Personal access token|Token de acesso pessoal)$/).fill(figmaToken);
  await panel.getByRole('button', { name: /^(Connect|Conectar)$/ }).click();
  await expect(panel.getByText(/Figma Fixture/)).toBeVisible({ timeout: 15000 });
  const connection = await ipc('plugins.figmaConnection', { namespace: 'figma', action: 'status' });
  assert.deepEqual(connection, { connected: true, account: 'Figma Fixture', toolCount: 6 });
  const { value } = await ipc('plugins.storageGet', { namespace: 'figma', key: 'mcp.connection' });
  assert.match(value, /"encryptedToken":"enc:/);
  assert.ok(!value.includes(figmaToken));
}

async function exerciseFigmaChat(projectId, title) {
  const chat = await api('coder/sessions', { project_id: projectId, title, provider: 'local-test', model: 'local-test' });
  const path = 'coder/sessions/' + chat.id + '/messages';
  await api(path, { content: 'Consulte o Figma em ' + figmaFile, response_mode: 'json', max_turns: 4 });
  await expect.poll(async () => JSON.stringify(await api(path)), { timeout: 45000 }).toContain(figmaReply);
  return app.evaluate(() => globalThis.figmaMetadataReads);
}

try {
  await boot();
  await page.getByRole('button', { name: /^(Continue|Continuar)$/ }).click({ timeout: 60000 });
  await page.getByRole('button', { name: /^(Get started|Começar)$/ }).click();
  await page.getByRole('button', { name: /^(Skip for now|Pular por enquanto)$/ }).click();
  await page.getByPlaceholder('D:\\Projects\\my-app').fill(project);
  await page.getByRole('button', { name: /^(Open project|Abrir projeto)$/ }).click();
  await expect.poll(() => page.url(), { timeout: 60000 }).toMatch(/#\/projects\/\d+/);
  await assertProviderSurface();
  const { profile: semanticProfile } = await api('admin/semantic/profiles/code');
  assert.match(semanticProfile.embedding_target.model, /granite-embedding-97m-multilingual-r2/);
  const embeddingProbe = await api('admin/semantic/probe', { capability: 'embedding', target: semanticProfile.embedding_target });
  assert.equal(embeddingProbe.dimension, 384);
  assert.equal((await api('admin/model-prices')).remoteSyncEnabled, false);
  const priceSync = await api('admin/model-prices/sync', {});
  assert.equal(priceSync.remoteSyncDisabled, true);
  assert.deepEqual(priceSync.sources, []);
  await exerciseElectronChromium();
  await exerciseCopilotRuntime();
  await exerciseCopilotLogin();
  await stubFigma();
  await exerciseFigmaPanel();
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
  const coldFigmaReads = await exerciseFigmaChat(projectId, 'Figma agent test');
  assert.equal(coldFigmaReads, 1);
  const figmaImageChat = await api('coder/sessions', {
    project_id: projectId, title: 'Figma attachment fixture', provider: 'local-test', model: 'local-test',
  });
  const figmaImageSession = 'coder/sessions/' + figmaImageChat.id;
  await api(figmaImageSession + '/messages', {
    content: `${captureFigmaImage} from ${figmaShotFile}`, response_mode: 'json', max_turns: 2,
  });
  await expect.poll(() => app.evaluate(() => globalThis.figmaImageReads), { timeout: 45000 }).toBe(1);
  await expect.poll(async () => (await api(figmaImageSession + '/status')).active, { timeout: 45000 }).toBe(false);
  await api('admin/providers', { id: 'local-anthropic', name: 'Local Anthropic endpoint', kind: 'anthropic',
    base_url: local + '/v1', api_key: 'local-fixture', enabled: true, use_for_coder: true });
  await api('admin/providers/local-anthropic/models', { model_id: 'local-test', name: 'Local Anthropic model', enabled: true, context_window: 128000 });
  const anthropicChat = await api('coder/sessions', { project_id: projectId, title: 'Local Anthropic chat', provider: 'local-anthropic', model: 'local-test' });
  const anthropicSessionPath = 'coder/sessions/' + anthropicChat.id;
  await api(anthropicSessionPath + '/messages', { content: 'Responda em uma frase.', response_mode: 'json', max_turns: 1 });
  await expect.poll(async () => JSON.stringify(await api(anthropicSessionPath + '/messages')), { timeout: 90000 }).toContain(anthropicReply);
  assert.ok(anthropicCalls > 0);
  await app.close();
  app = undefined;
  await boot();
  assert.deepEqual(await ipc('plugins.figmaConnection', { namespace: 'figma', action: 'status' }),
    { connected: true, account: 'Figma Fixture', toolCount: 6 });
  await stubFigma(true);
  await api(figmaImageSession + '/messages', {
    content: `${reopenFigmaImage} with attachment_id=${figmaImageId}`, response_mode: 'json', max_turns: 3,
  });
  let figmaReopenReply;
  await expect.poll(async () => {
    const text = JSON.stringify(await api(figmaImageSession + '/messages'));
    figmaReopenReply = [reopenedImageReply, missingImageReply].find(message => text.includes(message));
    return figmaReopenReply;
  }, { timeout: 45000 }).toBeDefined();
  assert.equal(figmaReopenReply, reopenedImageReply);
  assert.equal(await app.evaluate(() => globalThis.figmaImageReads), 0);
  const warmFigmaReads = await exerciseFigmaChat(projectId, 'Figma project cache after restart');
  assert.equal(warmFigmaReads, 0);
  assert.ok(figmaProviderCalls >= 4);
  assert.equal(figmaSecretSeen, false);
  assert.equal(figmaVerificationNudges, 0);
  assert.ok((await api(area + '/api-client/collections')).collections.some(item => item.id === collection.id));
  assert.ok((await api(area + '/ssh/hosts')).hosts.some(item => item.id === host.id));
  assert.ok(JSON.stringify(await api(sessionPath + '/messages')).includes(reply));
  assert.ok(JSON.stringify(await api(anthropicSessionPath + '/messages')).includes(anthropicReply));
  assert.equal(existsSync(join(profile, 'cloud', 'account.json')), false);
  assert.equal(cloudCalls, 0);
  assert.deepEqual(errors, []);
  passed = true;
  console.log(JSON.stringify({ cleanOnboarding: true, localFilesAndGit: true, apiRoundTrip: true, persistedSshHost: true,
    bundledEmbedding: true, localModelPrices: true,
    electronChromium: true, copilotRuntime: true, copilotLogin: true, copilotQuota: true, quickQuota: true, supportedProviderKinds: 4, modelCalls, anthropicCalls,
    figmaPanel: true, figmaAttachmentReopened: true, figmaProviderCalls, figmaSecretSeen, figmaVerificationNudges, coldFigmaReads, warmFigmaReads,
    persistedReply: true, cloudCalls, rendererErrors: errors }));
} catch (error) {
  console.error('Isolated profile:', root);
  console.error('Figma provider calls in fixture:', figmaProviderCalls);
  if (electronStderr) console.error(electronStderr);
  if (electronLogs) console.error(electronLogs);
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
