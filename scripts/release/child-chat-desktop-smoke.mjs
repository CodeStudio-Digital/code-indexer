// Run with node scripts/release/child-chat-desktop-smoke.mjs <Windows release directory>.
// The real renderer, worker and mailbox talk to a loopback provider whose child response is gated.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { _electron as electron, expect } from '@playwright/test';

const providerId = 'review-loopback';

function scenario(wait) {
  const mode = wait ? 'wait' : 'background';
  const { promise, resolve: releaseChild } = Promise.withResolvers();
  return {
    wait, mode, gate: promise, releaseChild, childRequests: 0, delegated: false, receipts: [],
    parentModel: 'local-parent-' + mode, childModel: 'local-child-' + mode,
    parentTitle: 'Conversa ' + mode, childTitle: 'Revisor ' + mode, answer: 'RESULTADO-' + mode,
  };
}

function localProvider(cases) {
  return createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      let input = '';
      for await (const part of req) input += part;
      const request = JSON.parse(input);
      const test = cases.find(item => [item.parentModel, item.childModel].includes(request.model));
      if (!test) { res.writeHead(404); res.end(); return; }
      if (!request.stream) { // Ancillary requests such as the preflight classifier.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({
        id: 'chatcmpl-fixture', model: request.model, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }],
      }) + '\n\n');
      const userInput = JSON.stringify(request.messages.filter(msg => msg.role === 'user').at(-1)?.content);
      let reason = 'stop';
      if (request.model === test.childModel && userInput?.includes('Responda com ' + test.answer)) {
        test.childRequests++;
        chunk({ role: 'assistant' });
        await test.gate;
        chunk({ content: test.answer });
      } else if (request.model === test.parentModel && request.tools?.some(tool => tool.function?.name === 'create_chat')) {
        if (test.delegated) {
          const result = request.messages.filter(msg => msg.role === 'tool').at(-1);
          if (result) test.receipts.push(result.content);
          chunk({ role: 'assistant', content: 'PAI-' + test.mode });
        } else {
          test.delegated = true;
          const args = { title: test.childTitle, profile: 'review', prompt: 'Responda com ' + test.answer,
            provider: providerId, model: test.childModel, ...(test.wait ? { wait: true } : {}) };
          chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + test.mode, type: 'function',
            function: { name: 'create_chat', arguments: JSON.stringify(args) } }] });
          reason = 'tool_calls';
        }
      } else {
        chunk({ role: 'assistant', content: '{}' });
      }
      chunk({}, reason);
      res.end('data: [DONE]\n\n');
    } catch (error) { res.destroy(error); }
  });
}

function api(page, path, body) {
  return page.evaluate(async ({ path, body }) => {
    const options = body && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const response = await fetch('mcp://app/api/' + path, options);
    if (!response.ok) throw Error(path + ' ' + response.status + ' ' + await response.text());
    return response.json();
  }, { path, body });
}

async function verifyDelegation(page, test) {
  const parent = page.locator(`[data-session-id="${test.parentId}"]`).getByRole('button', { name: test.parentTitle, exact: true });
  await expect(parent).toBeVisible({ timeout: 70_000 });
  await parent.click();
  await expect(parent).toHaveAttribute('aria-current', 'page');
  const composer = page.getByRole('textbox', { name: 'Descreva uma tarefa de programação…' }).last();
  await composer.fill(test.wait ? 'Abra um chat filho revisor e aguarde a resposta.' : 'Abra um chat filho revisor para esta tarefa.');
  const started = Date.now();
  await page.getByRole('button', { name: 'Enviar', exact: true }).last().click();
  const child = page.locator('[data-session-depth="1"]').filter({ has: page.getByRole('button', { name: test.childTitle, exact: true }) });
  await expect(child).toBeVisible({ timeout: 65_000 });
  const visibleAfterMs = Date.now() - started;
  const childId = await child.getAttribute('data-session-id');
  await expect(parent).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => test.childRequests, { timeout: 60_000 }).toBe(1);
  const waitLabel = page.getByText('Aguardando resposta de ' + test.childTitle, { exact: true });
  if (test.wait) {
    await expect(waitLabel.first()).toBeVisible();
    assert.equal(test.receipts.length, 0);
    test.releaseChild();
    await expect.poll(() => test.receipts.some(receipt => receipt.includes(test.answer)), { timeout: 50_000 }).toBe(true);
    await expect(waitLabel).toHaveCount(0);
  } else {
    await expect(page.getByText('PAI-background', { exact: true }).first()).toBeVisible({ timeout: 45_000 });
    assert.ok(test.receipts[0]?.includes(childId) && test.receipts[0].includes('accepted for background execution'));
    test.releaseChild();
    await expect.poll(async () => {
      const { messages } = await api(page, 'coder/sessions/' + test.parentId + '/collaboration');
      return messages.filter(msg => msg.from === 'chat:' + childId && msg.to === 'chat:' + test.parentId && msg.body.includes(test.answer)).length;
    }, { timeout: 45_000 }).toBe(1);
  }
  await expect(parent).toHaveAttribute('aria-current', 'page');
  assert.equal(test.childRequests, 1);
  return { mode: test.mode, childVisibleBeforeAnswer: true, parentStayedSelected: true, visibleAfterMs, childRequests: test.childRequests,
    ...(test.wait ? { waitingLabelShown: true, finalAnswerReceived: true } : { parentReturnedBeforeAnswer: true, completionNoticeReceived: true }) };
}

if (!process.argv[2]) throw Error('Pass the release directory containing win-unpacked/CodeStudio.exe');
const release = resolve(process.argv[2]), executablePath = join(release, 'win-unpacked', 'CodeStudio.exe');
await access(executablePath);
const temp = await realpath(tmpdir());
const root = await mkdtemp(join(temp, 'codestudio-child-chat-'));
const project = join(root, 'project'), profile = join(root, 'profile'), data = join(root, 'data');
const cases = [scenario(false), scenario(true)];
const server = localProvider(cases);
let app, passed = false;
try {
  await mkdir(project);
  execFileSync('git', ['init', '-q'], { cwd: project, windowsHide: true });
  await mkdir(join(profile, 'cloud'), { recursive: true });
  await writeFile(join(profile, 'cloud', 'account.json'), JSON.stringify({ id: 'fixture', email: 'fixture@example.invalid', emailVerified: true, status: 'active' }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const local = 'http://127.0.0.1:' + server.address().port;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(MCP_|CODER_|CODESTUDIO_|ELECTRON_RUN_AS_NODE$)|(?:_API_KEY|_TOKEN|_SECRET)$/.test(key)));
  Object.assign(env, { MCP_DATA_DIR: data, MCP_INDEX_DB: join(data, 'index.db'), MCP_MODEL_CACHE_DIR: join(root, 'models'),
    MCP_RUNTIME_COORDINATION_DIR: join(root, 'coordination'), MCP_DISABLE_TELEMETRY: '1', PROVIDER_REFRESH_INTERVAL_MS: '0',
    CODESTUDIO_CLOUD_URL: local, CODESTUDIO_PORTAL_URL: local });
  app = await electron.launch({ executablePath, cwd: root, env, timeout: 90_000,
    args: ['--user-data-dir=' + profile, '--disable-gpu', '--disable-background-networking'] });
  const dashboard = () => app.windows().find(window => window.url().includes('/dashboard/index.html'));
  await expect.poll(() => Boolean(dashboard()), { timeout: 90_000 }).toBe(true);
  const page = dashboard();
  const { id } = await api(page, 'projects', { name: 'Workspace de teste', root_path: project });
  await api(page, 'admin/providers', { id: providerId, kind: 'openai', name: 'Loopback', enabled: true, use_for_coder: true,
    use_for_agent: true, auth_mode: 'api_key', api_key: 'synthetic', base_url: local + '/v1' });
  for (const test of cases) {
    for (const model of [test.parentModel, test.childModel]) {
      await api(page, 'admin/providers/' + providerId + '/models', { model_id: model, name: model, enabled: true, context_window: 128_000, default_max_tokens: 4096 });
    }
    const parent = await api(page, 'coder/sessions', { project_id: id, title: test.parentTitle, provider: providerId, model: test.parentModel,
      agent: 'build', max_turns: 5, max_auto_continues: 0 });
    test.parentId = parent.id;
  }
  await page.evaluate(({ id, parent }) => {
    localStorage.setItem('mcp-ide:onboarded', 'true');
    localStorage.setItem('codestudio:preflight-done', 'true');
    localStorage.setItem('i18n-lang', 'pt-BR');
    location.hash = '#/projects/' + id + '?session=' + parent;
  }, { id, parent: cases[0].parentId });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const checks = [];
  for (const test of cases) checks.push(await verifyDelegation(page, test));
  const report = { passed: true, version: await app.evaluate(({ app }) => app.getVersion()), provider: 'local HTTP fixture', checks };
  await writeFile(join(release, 'child-chat-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  passed = true;
} finally {
  for (const test of cases) test.releaseChild();
  if (app) {
    const proc = app.process();
    const exited = proc.exitCode === null && proc.signalCode === null ? once(proc, 'exit') : Promise.resolve();
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await exited;
  }
  server.closeAllConnections();
  server.close();
  if (passed && await realpath(root) === root && dirname(root) === temp) {
    await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  } else {
    console.error('Disposable test profile:', root);
  }
}
