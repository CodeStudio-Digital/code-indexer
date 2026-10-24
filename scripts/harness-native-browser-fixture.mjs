import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright-core';

// Local HTTPS fixture only. The service receives an explicit fixture DNS resolver;
// Chrome maps that test hostname to loopback. Production URL/DNS policy is unchanged.
export async function startNativeBrowserFixture(root) {
  const directory = join(root, 'browser-fixture'); await mkdir(directory);
  const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem');
  execFileSync('C:/Program Files/Git/usr/bin/openssl.exe', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=harness-public.test'],
  { windowsHide: true, stdio: 'pipe', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  let effects = 0, blockedWrites = 0;
  const html = `<html><head><title>Anonymous browser fixture</title></head><body>
<h1>Research fixture</h1><input aria-label="Search"><button id="action">Action</button><button disabled>Disabled</button>
<p id="result">Ready</p><script>
const input=document.querySelector('input'); input.onkeydown=e=>{if(e.key==='Enter')document.querySelector('#result').textContent='SEARCH:'+input.value};
document.querySelector('#action').onclick=()=>{document.querySelector('#result').textContent='CLICKED';fetch('/observe');fetch('/write',{method:'POST'}).catch(()=>{});};
localStorage.setItem('fixture','anonymous');
</script></body></html>`;
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, async (request, response) => {
    if (request.url === '/observe') {
      effects++; await writeFile(join(directory, 'effects.json'), JSON.stringify({ effects }));
    }
    if (request.method === 'POST') blockedWrites++;
    response.setHeader('content-type', 'text/html'); response.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browserServer, browser;
  try {
    browserServer = await chromium.launchServer({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
      headless: true, args: ['--host-resolver-rules=MAP harness-public.test 127.0.0.1', '--ignore-certificate-errors', '--no-proxy-server'] });
    browser = await chromium.connect(browserServer.wsEndpoint());
    const sentinel = await browser.newContext(), page = await sentinel.newPage();
    await page.setContent('<title>Borrowed browser sentinel</title>');
    const tracked = new Set([browserServer.process().pid]);
    const capture = async () => {
      const cdp = await browser.newBrowserCDPSession();
      try { for (const info of (await cdp.send('SystemInfo.getProcessInfo')).processInfo) tracked.add(info.id); }
      finally { await cdp.detach(); }
    };
    return {
      url: `https://harness-public.test:${server.address().port}/`, endpoint: browserServer.wsEndpoint(), directory,
      effects: () => effects, blockedWrites: () => blockedWrites, capture,
      async assertBorrowedBrowser() { assert.equal(await page.title(), 'Borrowed browser sentinel'); },
      async close() {
        try { await capture(); } finally { await browserServer.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        const alive = () => [...tracked].filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
        for (let n = 0; n < 50 && alive().length; n++) await new Promise(resolve => setTimeout(resolve, 100));
        assert.deepEqual(alive(), [], 'fixture Chrome process survived close');
        return { reapedPids: [...tracked], policy: 'fixture DNS + local HTTPS; no user Chrome profile' };
      },
    };
  } catch (error) {
    await browserServer?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); throw error;
  }
}

export function nativeBrowserDelta(body, results, fixture) {
  const scenario = JSON.stringify(body.messages.filter(message => message.role === 'user')).match(/HARNESS_NATIVE_BROWSER_(COMPLETE|CANCEL|UNKNOWN)/)?.[1];
  if (!scenario) return;
  const call = calls => ({ role: 'assistant', tool_calls: calls.map(([name, args], index) => ({ index,
    id: `harness-browser-${results.length}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
  if (!results.length) {
    assert(body.tools.some(tool => tool.function?.name === 'browser_open'), 'native catalog lost browser_open');
    return call([['browser_open', { url: fixture.url }], ['browser_snapshot', {}]]);
  }
  for (const result of results) assert(!/Tool '.*' failed|outcome is unknown|No research browser/i.test(JSON.stringify(result.content)), JSON.stringify(result.content));
  // Fixed fixture DOM order: heading a1, search a2, action a3, disabled a4.
  if (scenario === 'CANCEL') return call([['browser_click', { ref: 'a4' }]]);
  if (scenario === 'UNKNOWN') {
    assert.equal(results.length, 2, 'provider resumed after uncertain browser action');
    return call([['browser_click', { ref: 'a3' }], ['create_file', { path: 'forbidden-after-browser.txt', content: 'must not execute' }]]);
  }
  if (results.length === 2) {
    assert(JSON.stringify(results[1].content).includes('Search'), 'browser snapshot lost actionable refs');
    return call([['browser_fill', { ref: 'a2', value: 'native-query' }], ['browser_press', { ref: 'a2', key: 'Enter' }],
      ['browser_extract', {}], ['browser_snapshot', {}]]);
  }
  if (results.length === 6) {
    assert(JSON.stringify(results[4].content).includes('SEARCH:native-query'), 'fill/press did not reach the page');
    return call([['browser_click', { ref: 'a3' }], ['browser_extract', {}], ['browser_screenshot', { full_page: true }], ['browser_close', {}]]);
  }
  assert.equal(results.length, 10, 'research tool batch lost or replayed');
  assert(JSON.stringify(results[7].content).includes('CLICKED'), 'click did not reach the page');
  assert(JSON.stringify(body.messages).includes('data:image/png;base64,'), 'provider lost browser screenshot');
  return { role: 'assistant', content: 'HARNESS_NATIVE_BROWSER_OK' };
}

export async function installNativeBrowserFixture(app, fixture) {
  await app.evaluate(async ({ app }, endpoint) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const { ResearchBrowserService } = require(join(app.getAppPath(), 'dist/packages/services/src/research-browser/service.js'));
    const bridge = require(join(app.getAppPath(), 'dist/packages/code-agent/src/tools/browser/bridge.js'));
    await bridge.getGlobalResearchBrowser()?.closeAll();
    const { chromium } = require('playwright-core');
    const service = new ResearchBrowserService(() => chromium.connect(endpoint),
      async hostname => hostname === 'harness-public.test' ? ['93.184.216.34'] : []);
    bridge.setGlobalResearchBrowser(service);
    const invoke = service.invoke.bind(service);
    service.invoke = async (request, scope) => {
      const result = await invoke(request, scope);
      if (global.__harnessBrowserDropAck && request.method === 'click') throw new Error('Intentional browser ACK loss');
      return result;
    };
    const { ChromeServiceStore } = require(join(app.getAppPath(), 'dist/packages/store/src/chrome-service-store.js'));
    const store = new ChromeServiceStore(process.env.MCP_INDEX_DB);
    try { store.patch({ enabled: true }); store.setStatus({ status: 'running' }); } finally { store.close(); }
  }, fixture.endpoint);
}

export async function runNativeBrowserFixture({ app, root, dashboard, post, projectId, setSession, fixture }) {
  await installNativeBrowserFixture(app, fixture);
  const cases = [];
  for (const scenario of ['COMPLETE', 'CANCEL', 'UNKNOWN']) {
    let caseRoot = root, caseProjectId = projectId;
    if (scenario === 'UNKNOWN') {
      caseRoot = join(dirname(root), 'browser-unknown-project'); await mkdir(caseRoot);
      caseProjectId = (await post('/api/projects', { name: 'Browser uncertain outcome fixture', root_path: caseRoot })).id;
      await app.evaluate(() => { global.__harnessBrowserDropAck = true; });
    }
    const before = fixture.effects();
    const session = await post('/api/coder/sessions', { project_id: caseProjectId, title: `Native browser ${scenario}`,
      provider: 'harness-local', model: 'harness-model', agent: 'build', max_turns: 8 });
    setSession(session.id);
    await post(`/api/coder/sessions/${session.id}/tool-permission-mode`, { mode: 'unrestricted' }, 'PATCH');
    const result = await dashboard.evaluate(async ({ id, scenario }) => {
      const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({ content: `HARNESS_NATIVE_BROWSER_${scenario}`, profile: 'full', max_turns: 8 }) });
      if (!response.ok || !response.body) throw new Error(`browser run ${response.status}: ${await response.text()}`);
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let stream = '', buffer = '', aborted = false;
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        const text = decoder.decode(next.value, { stream: true }); stream += text; buffer += text;
        const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() ?? '';
        for (const frame of frames) {
          if (scenario !== 'CANCEL' || aborted || !/^event: tool_call_start$/m.test(frame)) continue;
          const data = JSON.parse(frame.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n'));
          if (data.name !== 'browser_click') continue;
          const cancelled = await fetch(`mcp://app/api/coder/sessions/${id}/abort`, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: '{}' });
          if (!cancelled.ok) throw new Error('Browser cancellation failed'); aborted = true;
        }
      }
      return { stream, aborted };
    }, { id: session.id, scenario });
    if (scenario === 'COMPLETE') assert(result.stream.includes('HARNESS_NATIVE_BROWSER_OK'), result.stream.slice(-5000));
    else if (scenario === 'CANCEL') assert(result.aborted, 'browser click never reached cancellation');
    else {
      assert(result.stream.includes('TOOL_OUTCOME_UNKNOWN'), 'uncertain browser did not stop native attempt');
      await assert.rejects(readFile(join(caseRoot, 'forbidden-after-browser.txt')), { code: 'ENOENT' });
      await assertNativeBrowserRecovery(dashboard, session.id);
    }
    if (scenario !== 'CANCEL') {
      for (let n = 0; n < 50 && fixture.effects() === before; n++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(fixture.effects(), before + 1, 'browser action was lost or replayed');
    }
    const remaining = await app.evaluate(({ app }) => {
      const { join } = process.getBuiltinModule('node:path');
      const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
      const service = require(join(app.getAppPath(), 'dist/packages/code-agent/src/tools/browser/bridge.js')).getGlobalResearchBrowser();
      return { contexts: service.ownedContexts.size, owners: service.scopeOwners.size, operations: service.operations.keys() };
    });
    assert.deepEqual(remaining, { contexts: 0, owners: 0, operations: [] }, 'native browser survived terminal event');
    await fixture.assertBorrowedBrowser(); await fixture.capture();
    assert.equal(fixture.blockedWrites(), 0, 'research browser permitted non-read traffic');
    cases.push({ scenario, sessionId: session.id, root: caseRoot, uniqueTools: scenario === 'COMPLETE' ? 8 : 3,
      effects: fixture.effects() - before, remaining, borrowedBrowserPreserved: true });
  }
  return { cases, networkPolicy: 'HTTPS fixture; POST blocked; anonymous context; borrowed browser preserved' };
}

export async function assertNativeBrowserRecovery(dashboard, sessionId) {
  const result = await dashboard.evaluate(async id => {
    const history = await fetch(`mcp://app/api/coder/sessions/${id}?full=1`).then(response => response.json());
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/continue`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000), body: JSON.stringify({ max_auto_continues: 0 }) });
    return { history, continued: await response.text() };
  }, sessionId);
  assert(JSON.stringify(result.history.messages).includes('"effect_outcome":"unknown"'), 'browser history lost uncertain outcome');
  assert(result.continued.includes('TOOL_OUTCOME_UNKNOWN'), 'browser continuation repeated an uncertain action');
  return { uncertainOutcomeRetained: true, continuationBlocked: true };
}
