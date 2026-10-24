import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function prepareNativePreviewFixture(root) {
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, scripts: { dev: 'node preview-fixture.cjs' } }));
  await writeFile(join(root, 'preview-fixture.cjs'), `
const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',windowsHide:true});
const html='<html><head><title>Native preview fixture</title></head><body><button id="button">Action</button><input id="input"><div style="height:2000px">Fixture</div><script>window.events={click:0,double:0,right:0,enter:0};const b=document.querySelector("#button"),i=document.querySelector("#input");b.onclick=()=>events.click++;b.ondblclick=()=>events.double++;b.oncontextmenu=e=>{e.preventDefault();events.right++};i.onkeydown=e=>{if(e.key==="Enter")events.enter++};console.log("NATIVE_PREVIEW_READY");localStorage.setItem("fixture","native");fetch("/payload");</script></body></html>';
const server=require('node:http').createServer((req,res)=>{if(req.url==='/mutate'){require('node:fs').appendFileSync('preview-effect.log','effect\\n');res.end('CONFIRMED_REMOTE_EFFECT');return}res.setHeader('content-type',req.url==='/payload'?'application/json':'text/html');res.end(req.url==='/payload'?'{}':html)});
server.listen(0,'127.0.0.1',()=>{const url='http://127.0.0.1:'+server.address().port;require('node:fs').writeFileSync('preview-pids.json',JSON.stringify({pids:[process.pid,child.pid],url}));console.log('Local: '+url)});
`);
}

const inspections = [
  ['preview_snapshot', { interactiveOnly: true }], ['preview_fill', { selector: '#input', value: 'native' }],
  ['preview_type', { text: '-typed', selector: '#input' }], ['preview_press', { key: 'Enter', selector: '#input' }],
  ['preview_click', { selector: '#button' }], ['preview_double_click', { selector: '#button' }],
  ['preview_right_click', { selector: '#button' }], ['preview_hover', { selector: '#button' }],
  ['preview_scroll', { y: 300 }], ['preview_viewport', { preset: 'mobile' }],
  ['preview_wait_for', { selector: '#button' }], ['preview_inspect_css', { selector: '#button' }],
  ['preview_console', {}], ['preview_network', { includeBody: true }], ['preview_storage', {}],
  ['preview_memory', {}], ['preview_performance', {}], ['preview_screenshot', {}],
  ['preview_eval', { js: 'JSON.stringify({events,value:document.querySelector("#input").value})' }],
];
export function nativePreviewDelta(body, results) {
  const scenario = JSON.stringify(body.messages.filter(message => message.role === 'user')).match(/HARNESS_NATIVE_PREVIEW_(COMPLETE|CANCEL|UNKNOWN)/)?.[1];
  if (!scenario) return;
  const call = calls => ({ role: 'assistant', tool_calls: calls.map(([name, args], index) => ({ index,
    id: `harness-preview-${results.length}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
  if (!results.length) {
    assert(body.tools.some(tool => tool.function?.name === 'preview_open'), 'native catalog lost preview_open');
    return call([['preview_open', {}]]);
  }
  const opened = JSON.stringify(results[0].content);
  const url = opened.match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+/)?.[0];
  assert(url && opened.includes('started a dev server'), `native preview did not start its server: ${opened}`);
  if (scenario === 'CANCEL') return call([['preview_wait_for', { selector: '#never-exists', timeoutMs: 30_000 }]]);
  if (scenario === 'UNKNOWN') {
    assert.equal(results.length, 1, 'provider resumed after uncertain preview effect');
    return call([['preview_eval', { js: '/* HARNESS_DROP_PREVIEW_ACK */ fetch("/mutate",{method:"POST"}).then(r=>r.text())' }],
      ['create_file', { path: 'forbidden-after-preview.txt', content: 'must not execute' }]]);
  }
  if (results.length === 1) return call(inspections);
  for (const result of results) assert(!/Tool '.*' failed|Native preview has no|outcome is unknown/i.test(JSON.stringify(result.content)), 'preview effect failed');
  const inspection = JSON.stringify(results.find(result => result.tool_call_id === 'harness-preview-1-18')?.content);
  assert(inspection?.includes('native-typed') && inspection.includes('events'), 'preview interactions did not reach the page');
  assert(JSON.stringify(body.messages).includes('data:image/png;base64,'), 'native provider lost preview screenshot');
  if (results.length === 20) return call([['preview_navigate', { url: url + '/?again=1' }], ['preview_close', {}]]);
  assert.equal(results.length, 22, 'preview tool batch was lost or replayed');
  return { role: 'assistant', content: 'HARNESS_NATIVE_PREVIEW_OK' };
}

export async function runNativePreviewFixture({ app, root, dashboard, post, projectId, setSession }) {
  const cases = [];
  for (const scenario of ['COMPLETE', 'CANCEL', 'UNKNOWN']) {
    let caseRoot = root, caseProjectId = projectId;
    if (scenario === 'UNKNOWN') {
      caseRoot = join(dirname(root), 'preview-unknown-project'); await mkdir(caseRoot);
      await prepareNativePreviewFixture(caseRoot);
      const project = await post('/api/projects', { name: 'Preview uncertain outcome fixture', root_path: caseRoot });
      caseProjectId = project.id;
      await app.evaluate(({ app }) => {
        const { join } = process.getBuiltinModule('node:path');
        const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
        const service = require(join(app.getAppPath(), 'dist/packages/code-agent/src/tools/preview/index.js')).getGlobalPreviewDevtools();
        const invoke = service.invoke.bind(service);
        service.invoke = async (request, scope) => {
          const result = await invoke(request, scope);
          if (request.method === 'eval' && request.args?.js?.includes('HARNESS_DROP_PREVIEW_ACK')) throw new Error('Intentional preview ACK loss after effect');
          return result;
        };
      });
    }
    const session = await post('/api/coder/sessions', { project_id: caseProjectId, title: `Native preview ${scenario}`,
      provider: 'harness-local', model: 'harness-model', agent: 'build', max_turns: 6 });
    setSession(session.id);
    await post(`/api/coder/sessions/${session.id}/tool-permission-mode`, { mode: 'unrestricted' }, 'PATCH');
    const result = await dashboard.evaluate(async ({ id, scenario }) => {
      const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({ content: `HARNESS_NATIVE_PREVIEW_${scenario}`, profile: 'full', max_turns: 6 }) });
      if (!response.ok || !response.body) throw new Error(`preview run ${response.status}: ${await response.text()}`);
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let stream = '', buffer = '', aborted = false, cancellationFailure;
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        const text = decoder.decode(next.value, { stream: true }); stream += text; buffer += text;
        const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() ?? '';
        for (const frame of frames) {
          if (scenario !== 'CANCEL' || aborted || !/^event: tool_call_start$/m.test(frame)) continue;
          const data = JSON.parse(frame.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n'));
          if (data.name !== 'preview_wait_for') continue;
          const cancelled = await fetch(`mcp://app/api/coder/sessions/${id}/abort`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          if (!cancelled.ok) cancellationFailure = `Preview cancellation failed (${cancelled.status}): ${await cancelled.text()}`;
          aborted = true;
        }
      }
      return { stream, aborted, cancellationFailure };
    }, { id: session.id, scenario });
    if (scenario === 'COMPLETE') assert(result.stream.includes('HARNESS_NATIVE_PREVIEW_OK'), result.stream.slice(-4000));
    else if (scenario === 'CANCEL') {
      assert(!result.cancellationFailure, `${result.cancellationFailure}\n${result.stream.slice(-6000)}`);
      assert(result.aborted, 'preview wait never reached cancellation');
      assert(/"interrupted":true/.test(result.stream) && /"reason":"aborted"/.test(result.stream),
        `preview cancellation did not preserve its interrupted terminal: ${result.stream.slice(-4000)}`);
      assert(!result.stream.includes('TOOL_OUTCOME_UNKNOWN'), 'read-only preview wait acquired an uncertain effect');
    }
    else {
      assert(result.stream.includes('TOOL_OUTCOME_UNKNOWN'), 'uncertain preview did not stop the native attempt');
      assert.equal(await readFile(join(caseRoot, 'preview-effect.log'), 'utf8'), 'effect\n', 'uncertain preview effect was replayed');
      await assert.rejects(readFile(join(caseRoot, 'forbidden-after-preview.txt')), { code: 'ENOENT' });
      await assertNativePreviewRecovery(dashboard, session.id, caseRoot);
    }
    const owner = JSON.parse(await readFile(join(caseRoot, 'preview-pids.json'), 'utf8'));
    for (const pid of owner.pids) assert.throws(() => process.kill(pid, 0), 'native preview process survived its terminal event');
    const windows = await app.evaluate(({ BrowserWindow }, port) => BrowserWindow.getAllWindows()
      .filter(win => { try { return new URL(win.webContents.getURL()).port === port; } catch { return false; } })
      .map(win => win.id), new URL(owner.url).port);
    assert.deepEqual(windows, [], 'native preview window survived its terminal event');
    cases.push({ scenario, sessionId: session.id, root: caseRoot, tools: scenario === 'COMPLETE' ? 22 : 2,
      autoStartedServer: true, reapedPids: owner.pids, windowsAfterTerminal: windows,
      ...(scenario === 'CANCEL' ? { interrupted: true, reason: 'aborted' } : {}) });
  }
  return { cases };
}

export async function assertNativePreviewRecovery(dashboard, sessionId, root) {
  const result = await dashboard.evaluate(async id => {
    const history = await fetch(`mcp://app/api/coder/sessions/${id}?full=1`).then(response => response.json());
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/continue`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000), body: JSON.stringify({ max_auto_continues: 0 }) });
    return { history, continued: await response.text() };
  }, sessionId);
  assert(JSON.stringify(result.history.messages).includes('"effect_outcome":"unknown"'), 'preview history lost uncertain outcome');
  assert(result.continued.includes('TOOL_OUTCOME_UNKNOWN'), 'preview continuation repeated an uncertain effect');
  assert.equal(await readFile(join(root, 'preview-effect.log'), 'utf8'), 'effect\n');
  return { uncertainOutcomeRetained: true, continuationBlocked: true, remoteEffects: 1 };
}
