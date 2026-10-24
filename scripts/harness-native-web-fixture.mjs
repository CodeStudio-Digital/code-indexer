import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

/** A trusted test preload pins public fixture names to a local TLS server.
 * It never ships in the app and does not expose a production SSRF bypass. */
export async function startNativeWebFixture(root) {
  const directory = join(root, 'web-fixture'); await mkdir(directory);
  const keyPath = join(directory, 'key.pem'), certPath = join(directory, 'cert.pem');
  execFileSync('C:/Program Files/Git/usr/bin/openssl.exe', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=harness-public.test',
    '-addext', 'subjectAltName=DNS:harness-public.test,DNS:api.search.brave.com,DNS:html.duckduckgo.com'],
  { windowsHide: true, stdio: 'pipe', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  const cert = await readFile(certPath, 'utf8');
  const sockets = new Set(), calls = []; let active = 0, maxActive = 0, stalled = 0;
  const server = createServer({ key: await readFile(keyPath), cert }, (req, res) => {
    calls.push(req.url); active++; maxActive = Math.max(active, maxActive); res.once('close', () => active--);
    if (req.url === '/stall') { stalled++; res.writeHead(200, { 'content-encoding': 'gzip' }); res.flushHeaders(); return; }
    if (req.url === '/redirect') { res.writeHead(302, { location: '/page' }); res.end(); return; }
    if (req.url === '/private') { res.writeHead(302, { location: 'http://127.0.0.1/private' }); res.flushHeaders(); return; }
    if (req.url?.startsWith('/res/v1/web/search')) {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ web: { results: [
        { title: 'Canonical docs', url: 'https://docs.python.org/page', description: '<b>Docs</b>' },
        { title: 'Fake docs', url: 'https://python.org.evil.example/', description: 'Wrong host' },
      ] } })); return;
    }
    if (req.url === '/large') {
      const bytes = gzipSync('x'.repeat(80000)); res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': bytes.length }); res.end(bytes); return;
    }
    res.setHeader('content-type', 'text/html');
    const end = () => res.end('<html><h1>WEB FIXTURE</h1><p>' + req.url + '</p><script>LEAK_SENTINEL</script></html>');
    if (req.url === '/slow') setTimeout(end, 1500); else end();
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, preload = join(directory, 'web-preload.cjs');
  await writeFile(preload, `
const { Resolver } = require('node:dns/promises');
const https = require('node:https');
const hosts = new Set(['harness-public.test','api.search.brave.com','html.duckduckgo.com']);
const resolve4 = Resolver.prototype.resolve4, resolve6 = Resolver.prototype.resolve6;
Resolver.prototype.resolve4 = function(host,...args) { return hosts.has(host) ? Promise.resolve(['93.184.216.34']) : resolve4.call(this,host,...args); };
Resolver.prototype.resolve6 = function(host,...args) { return hosts.has(host) ? Promise.resolve([]) : resolve6.call(this,host,...args); };
const request = https.request;
https.request = function(url, options, ...args) {
  if (url instanceof URL && hosts.has(url.hostname)) {
    let pinned;
    options.lookup(url.hostname,{family:4,all:false},(_error,address)=>{pinned=address;});
    if (pinned !== '93.184.216.34') throw new Error('Fixture request lost its validated address pin');
    options = {...options, port:${port}, ca:${JSON.stringify(cert)}, lookup:(_host,_opts,cb)=>cb(null,'127.0.0.1',4)};
  }
  return request.call(this,url,options,...args);
};
process.env.BRAVE_API_KEY = 'local-fixture-only';
require('node:module').syncBuiltinESMExports();
`);
  return { url: `https://harness-public.test:${port}`, preload, calls, maxActive: () => maxActive, stalled: () => stalled,
    async assertDrained() { for (let n = 0; n < 100 && sockets.size; n++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(sockets.size, 0); },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

export function nativeWebDelta(body, fixture) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_WEB_/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  const scenario = JSON.stringify(body.messages[start].content).match(/HARNESS_NATIVE_WEB_(COMPLETE|CANCEL)/)?.[1];
  if (!scenario) return;
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  const text = result => typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
  const fetch = path => ['web_fetch', { url: fixture.url + path }];
  const call = calls => ({ role: 'assistant', tool_calls: calls.map(([name, args], index) => ({ index,
    id: `harness-web-${scenario}-${results.length}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
  for (const name of ['web_fetch', 'web_search']) assert(body.tools.some(t => t.function?.name === name), 'missing native ' + name);
  if (!results.length) return call(scenario === 'CANCEL' ? [fetch('/page')] : [fetch('/slow'), fetch('/fast'), fetch('/redirect'), ['web_search', { query: 'fixture docs', allowed_domains: ['python.org'] }]]);
  if (scenario === 'CANCEL') return call([fetch('/stall')]);
  if (results.length === 4) {
    assert(text(results[0]).includes('/slow')); assert(text(results[1]).includes('/fast'));
    assert(text(results[2]).includes('/page')); assert(!JSON.stringify(results).includes('LEAK_SENTINEL'));
    assert(text(results[3]).includes('docs.python.org')); assert(!text(results[3]).includes('evil.example'));
    return call([['web_fetch', { url: fixture.url + '/large', max_bytes: 1024 }], fetch('/private'), fetch('/page')]);
  }
  assert.equal(results.length, 7); assert(text(results[4]).includes('source truncated')); assert(text(results[5]).includes('private/loopback'));
  assert(text(results[6]).includes('WEB FIXTURE')); assert(fixture.maxActive() >= 2, 'native reads did not overlap');
  return { role: 'assistant', content: 'HARNESS_NATIVE_WEB_COMPLETE_OK' };
}

export async function runNativeWebFixture({ app, root, dashboard, post, setSession, fixture }) {
  await app.evaluate(({ app }, preload) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const pool = require(join(app.getAppPath(), 'dist/apps/http-api/sse/coderWorkerPoolSingleton.js')).getCoderWorkerPool();
    pool.opts.workerExecArgv = [...(pool.opts.workerExecArgv ?? []), '--require', preload];
  }, fixture.preload);
  const cases = [];
  for (const scenario of ['COMPLETE', 'CANCEL']) {
    const caseRoot = join(dirname(root), 'web-' + scenario.toLowerCase()); await mkdir(caseRoot);
    const project = await post('/api/projects', { name: 'Web ' + scenario, root_path: caseRoot });
    const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Native web ' + scenario,
      provider: 'harness-local', model: 'harness-model', agent: 'build', max_turns: 5 });
    setSession(session.id);
    await post(`/api/coder/sessions/${session.id}/tool-permission-mode`, { mode: 'unrestricted' }, 'PATCH');
    const result = await dashboard.evaluate(async ({ id, scenario }) => {
      const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000),
        body: JSON.stringify({ content: `HARNESS_NATIVE_WEB_${scenario}`, profile: 'full', max_turns: 5 }) });
      if (!response.ok || !response.body) throw new Error('Web fixture ' + response.status + ': ' + await response.text());
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let stream = '', buffer = '', starts = 0, aborted = false, cancelAckMs; const completions = [];
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        const text = decoder.decode(next.value, { stream: true }); stream += text; buffer += text;
        const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() ?? '';
        for (const frame of frames) {
          if (/^event: tool_call_result$/m.test(frame)) completions.push(frame);
          if (scenario !== 'CANCEL' || aborted || !/^event: tool_call_start$/m.test(frame) || ++starts !== 2) continue;
          await new Promise(resolve => setTimeout(resolve, 200)); const before = performance.now();
          const cancelled = await fetch(`mcp://app/api/coder/sessions/${id}/abort`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          cancelAckMs = performance.now() - before; if (!cancelled.ok) throw new Error('Web cancel failed'); aborted = true;
        }
      }
      return { stream, completions, aborted, cancelAckMs };
    }, { id: session.id, scenario });
    if (scenario === 'CANCEL') { assert(result.aborted); assert.equal(fixture.stalled(), 1); }
    else {
      assert(result.stream.includes('HARNESS_NATIVE_WEB_COMPLETE_OK'), result.stream.slice(-6000));
      const fast = result.completions.findIndex(x => x.includes('harness-web-COMPLETE-0-1'));
      const slow = result.completions.findIndex(x => x.includes('harness-web-COMPLETE-0-0'));
      assert(fast >= 0 && slow > fast, 'renderer did not receive fast result before slow one');
    }
    await fixture.assertDrained(); cases.push({ scenario, sessionId: session.id, cancelAckMs: result.cancelAckMs });
  }
  return { cases, maxConcurrentTransfers: fixture.maxActive(), requests: fixture.calls, policy: 'isolated fixture DNS/socket routing; TLS verified using fixture CA' };
}
