import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function startNativeHttpFixture() {
  const sockets = new Set(); let effects = 0, stalled = 0;
  const server = createServer((req, res) => {
    req.resume();
    if (req.url === '/lost-ack') { effects++; res.destroy(); return; }
    if (req.url === '/stall') { stalled++; return; }
    if (req.url === '/login') { res.setHeader('set-cookie', 'login=fixture; Path=/'); res.end('LOGIN_OK'); return; }
    if (req.url === '/me') {
      const authorized = req.headers.cookie?.includes('login=fixture');
      res.statusCode = authorized ? 200 : 401; res.end(authorized ? 'AUTHENTICATED' : 'ANONYMOUS'); return;
    }
    if (req.url === '/large') { res.end('x'.repeat(50000)); return; }
    if (req.url === '/failure') res.statusCode = 500;
    res.end('HTTP_FIXTURE');
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, effects: () => effects, stalled: () => stalled,
    sockets: () => sockets.size,
    async assertDrained() {
      for (let n = 0; n < 100 && sockets.size; n++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(sockets.size, 0, 'HTTP socket survived terminal event');
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

export function nativeHttpDelta(body, fixture) {
  const start = body.messages.findLastIndex(message => message.role === 'user' && /HARNESS_NATIVE_HTTP_/.test(JSON.stringify(message.content)));
  if (start < 0) return;
  const scenario = JSON.stringify(body.messages[start].content).match(/HARNESS_NATIVE_HTTP_(COMPLETE|FOLLOWUP|CANCEL|UNKNOWN)/)?.[1];
  if (!scenario) return;
  const results = body.messages.slice(start + 1).filter(message => message.role === 'tool');
  const http = (path, extra = {}) => ['http_request', { url: fixture.url + path, ...extra }];
  const call = calls => ({ role: 'assistant', tool_calls: calls.map(([name, args], index) => ({ index,
    id: `harness-http-${scenario}-${results.length}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
  assert(body.tools.some(tool => tool.function?.name === 'http_request'), 'missing HTTP native tool');
  for (const result of results) assert(!/http_request failed|outcome is unknown|Tool '.*' failed/i.test(JSON.stringify(result.content)), JSON.stringify(result.content));
  if (!results.length) {
    if (scenario === 'UNKNOWN') return call([http('/lost-ack', { method: 'POST', json: { fixture: true } }),
      ['create_file', { path: 'forbidden-after-http.txt', content: 'must not run' }]]);
    if (scenario === 'CANCEL') return call([http('/health')]);
    if (scenario === 'FOLLOWUP') return call([http('/me'), http('/me', { resetCookies: true })]);
    return call([http('/health'), http('/login', { method: 'POST' }), http('/me')]);
  }
  assert.notEqual(scenario, 'UNKNOWN', 'provider resumed after an uncertain POST');
  if (scenario === 'CANCEL') return call([http('/stall')]);
  if (scenario === 'FOLLOWUP') {
    assert.equal(results.length, 2);
    assert(JSON.stringify(results[0].content).includes('AUTHENTICATED'), 'session login lost between attempts');
    assert(JSON.stringify(results[1].content).includes('401'), 'cookie reset failed');
  } else if (results.length === 3) {
    assert(JSON.stringify(results[2].content).includes('AUTHENTICATED'));
    return call([http('/large', { maxBytes: 2048 }), http('/failure'), http('/health', { method: 'HEAD' }), http('/health', { method: 'OPTIONS' })]);
  } else {
    assert.equal(results.length, 7);
    assert(JSON.stringify(results[3].content).includes('source truncated'), 'read ceiling was not reported');
    assert(JSON.stringify(results[4].content).includes('500'), 'HTTP status was lost');
  }
  return { role: 'assistant', content: `HARNESS_NATIVE_HTTP_${scenario}_OK` };
}

export async function runNativeHttpFixture({ root, dashboard, post, setSession, fixture }) {
  const cases = []; let complete;
  for (const scenario of ['COMPLETE', 'FOLLOWUP', 'CANCEL', 'UNKNOWN']) {
    let sessionId, caseRoot;
    if (scenario === 'FOLLOWUP') { sessionId = complete.sessionId; caseRoot = complete.root; }
    else {
      caseRoot = join(dirname(root), `http-${scenario.toLowerCase()}`); await mkdir(caseRoot);
      const project = await post('/api/projects', { name: `HTTP ${scenario}`, root_path: caseRoot });
      const session = await post('/api/coder/sessions', { project_id: project.id, title: `Native HTTP ${scenario}`,
        provider: 'harness-local', model: 'harness-model', agent: 'build', max_turns: 5 });
      sessionId = session.id;
      await post(`/api/coder/sessions/${sessionId}/tool-permission-mode`, { mode: 'unrestricted' }, 'PATCH');
    }
    setSession(sessionId);
    const result = await dashboard.evaluate(async ({ id, scenario }) => {
      const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000),
        body: JSON.stringify({ content: `HARNESS_NATIVE_HTTP_${scenario}`, profile: 'full', max_turns: 5 }) });
      if (!response.ok || !response.body) throw new Error(`HTTP fixture ${response.status}: ${await response.text()}`);
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let stream = '', buffer = '', starts = 0, aborted = false, cancelAckMs;
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        const text = decoder.decode(next.value, { stream: true }); stream += text; buffer += text;
        const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() ?? '';
        for (const frame of frames) {
          if (scenario !== 'CANCEL' || aborted || !/^event: tool_call_start$/m.test(frame) || ++starts !== 2) continue;
          await new Promise(resolve => setTimeout(resolve, 200));
          const before = performance.now();
          const cancelled = await fetch(`mcp://app/api/coder/sessions/${id}/abort`, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: '{}' });
          cancelAckMs = performance.now() - before; if (!cancelled.ok) throw new Error('HTTP cancellation failed'); aborted = true;
        }
      }
      return { stream, aborted, cancelAckMs };
    }, { id: sessionId, scenario });
    if (scenario === 'CANCEL') { assert(result.aborted, result.stream.slice(-5000)); assert.equal(fixture.stalled(), 1); }
    else if (scenario === 'UNKNOWN') {
      assert(result.stream.includes('TOOL_OUTCOME_UNKNOWN'), result.stream.slice(-5000));
      assert.equal(fixture.effects(), 1); await assert.rejects(readFile(join(caseRoot, 'forbidden-after-http.txt')), { code: 'ENOENT' });
      await assertNativeHttpRecovery(dashboard, sessionId);
    } else assert(result.stream.includes(`HARNESS_NATIVE_HTTP_${scenario}_OK`), result.stream.slice(-5000));
    await fixture.assertDrained();
    const evidence = { scenario, sessionId, root: caseRoot, remainingSockets: fixture.sockets(), cancelAckMs: result.cancelAckMs };
    cases.push(evidence); if (scenario === 'COMPLETE') complete = evidence;
  }
  return { cases, effectCount: fixture.effects() };
}

export async function assertNativeHttpRecovery(dashboard, sessionId) {
  const result = await dashboard.evaluate(async id => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/continue`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60000), body: JSON.stringify({ max_auto_continues: 0 }) });
    return response.text();
  }, sessionId);
  assert(result.includes('TOOL_OUTCOME_UNKNOWN'), 'HTTP continuation repeated an uncertain request');
  return { continuationBlocked: true };
}
