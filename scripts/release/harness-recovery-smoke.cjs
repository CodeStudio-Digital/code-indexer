// Run with the candidate Electron executable in Node mode, the compiled dist directory
// (inside app.asar for a release), and a scratch directory. All model traffic is local.
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const dist = resolve(process.argv[2]);
const output = mkdtempSync(join(resolve(process.argv[3]), 'harness-recovery-'));
const profile = join(output, 'profile');
const projectRoot = join(output, 'project');
mkdirSync(profile);
mkdirSync(projectRoot);
process.chdir(output);
for (const name of Object.keys(process.env)) {
  if (/(API_KEY|ACCESS_KEY|SECRET|AUTH_TOKEN|AWS_PROFILE)/i.test(name)) delete process.env[name];
}
Object.assign(process.env, {
  MCP_DATA_DIR: profile, MCP_INDEX_DB: join(profile, 'index.db'),
  MCP_RUNTIME_COORDINATION_DIR: join(profile, 'coordination'), MCP_MODEL_CACHE_DIR: join(profile, 'models'),
  CODER_PREFLIGHT: '0', CODER_FALLBACK_CHAIN: '', HEAP_LOG_INTERVAL_MS: '0',
  PROVIDER_REFRESH_INTERVAL_MS: '0', MODEL_PRICING_REFRESH_INTERVAL_MS: '0', MODEL_PRICING_REMOTE_ENABLED: '0',
});
const load = relative => require(join(dist, relative));
const report = { passed: false, provider: 'loopback fixture', turns: [], ancillaryModelCalls: 0,
  workerStarts: [], lostDrainAcknowledgements: 0, timingsMs: {} };

async function main() {
  const provider = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404); res.end(); return;
    }
    const request = JSON.parse(body);
    const input = request.messages.filter(message => message.role === 'user').at(-1);
    const turn = ['first', 'second', 'third', 'fourth'].find(name => JSON.stringify(input).includes('synthetic-' + name));
    if (!turn) { res.writeHead(422); res.end(); return; }
    if (request.tools?.length) report.turns.push(turn);
    else report.ancillaryModelCalls++;
    if (!request.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'Fixture' }, finish_reason: 'stop' }] }));
      return;
    }
    const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({
      id: 'chatcmpl-fixture', object: 'chat.completion.chunk', model: request.model,
      choices: [{ index: 0, delta, finish_reason }],
    }) + '\n\n';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(chunk({ role: 'assistant', content: 'local-answer-' + turn }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  let runtime;
  try {
    runtime = load('apps/http-api/server.js').createApp();
    const { db, deps, app } = runtime;
    const project = db.createProject('Recovery fixture', projectRoot);
    deps.providerStore.upsertProvider({ id: 'recovery-local', name: 'Recovery fixture', kind: 'openai',
      base_url: 'http://127.0.0.1:' + provider.address().port + '/v1', api_key: 'synthetic-local',
      enabled: true, is_default: true, use_for_coder: true });
    deps.providerStore.replaceModelsFromSource('recovery-local', 'manual', [
      { model_id: 'fixture', name: 'Fixture', context_window: 65536, enabled: true },
    ]);
    const post = (url, body) => app.fetch(new Request('http://127.0.0.1' + url, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const created = await post('/api/coder/sessions', { title: 'Recovery fixture', project_id: project.id,
      provider: 'recovery-local', model: 'fixture' });
    const session = await created.json();
    assert.equal(created.status, 201, JSON.stringify(session));
    report.sessionId = session.id;
    const url = '/api/coder/sessions/' + session.id;
    const pool = load('apps/http-api/sse/coderWorkerPoolSingleton.js').getCoderWorkerPool();
    const send = async turn => {
      const started = performance.now();
      const response = await post(url + '/messages', { client_msg_id: 'fixture-' + turn, content: 'synthetic-' + turn });
      const stream = await response.text();
      assert.equal(response.status, 200, stream.slice(-1200));
      assert.match(stream, /event: done/, stream.slice(-1200));
      assert.ok(stream.includes('local-answer-' + turn), stream.slice(-1200));
      const metric = { first: 'coldTurn', second: 'turnAfterLostDrainAck', third: 'warmTurn', fourth: 'turnAfterFailedStartup' }[turn];
      report.timingsMs[metric] = Math.round(performance.now() - started);
    };
    const { MessageBridge } = load('packages/orchestrator-host/src/MessageBridge.js');
    const original = MessageBridge.prototype.request;
    const startedWorkers = new Set();
    MessageBridge.prototype.request = async function (type, ...args) {
      if (type === 'runFresh') { startedWorkers.add(this); report.workerStarts.push(args[0].userMessage); }
      const result = await original.call(this, type, ...args);
      // At this point the real isolate already fenced itself and released its writer.
      if (type === 'releaseSessionWriter' && !report.lostDrainAcknowledgements) {
        assert.equal(result.ok, true);
        report.lostDrainAcknowledgements++;
        throw new Error('fixture lost the first drain acknowledgement');
      }
      return result;
    };
    try {
      await send('first');
      await assert.rejects(pool.evict(session.id), /fixture lost/);
      await send('second');
      const replay = await post(url + '/messages', { client_msg_id: 'fixture-second', content: 'synthetic-second', response_mode: 'json' });
      assert.equal((await replay.json()).terminal.event, 'done');
      await send('third');
    } finally { MessageBridge.prototype.request = original; }
    assert.deepEqual(report.workerStarts, ['synthetic-first', 'synthetic-second', 'synthetic-third']);
    assert.equal(startedWorkers.size, 2);
    assert.deepEqual(report.turns, ['first', 'second', 'third']);
    const stopStarted = performance.now();
    await pool.evict(session.id);
    report.timingsMs.cleanWorkerShutdown = Math.round(performance.now() - stopStarted);
    assert.equal(pool.has(session.id), false);
    if (process.argv.includes('--check-startup-refusal')) {
      let lostAcquisitionAck = false;
      MessageBridge.prototype.request = async function (type, ...args) {
        const result = await original.call(this, type, ...args);
        if (type === 'acquireSessionWriter' && !lostAcquisitionAck) {
          assert.equal(result.ok, true);
          lostAcquisitionAck = true;
          throw new Error('fixture lost writer acquisition acknowledgement');
        }
        return result;
      };
      try {
        const body = { client_msg_id: 'fixture-refused', content: 'synthetic-fourth', response_mode: 'json' };
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await post(url + '/messages', body);
          assert.equal(response.status, 200);
          const { terminal } = await response.json();
          assert.equal(terminal.event, 'error');
          assert.equal(terminal.data.reason, 'worker-unavailable-before-input');
          assert.equal(terminal.data.not_started, true);
        }
        assert.equal(lostAcquisitionAck, true);
        assert.deepEqual(report.turns, ['first', 'second', 'third']);
        await send('fourth');
        assert.deepEqual(report.turns, ['first', 'second', 'third', 'fourth']);
        report.startupRefusalRecovered = true;
      } finally { MessageBridge.prototype.request = original; }
    }
    const saved = await deps.sessionStore.loadSessionWithMessages(session.id);
    const history = saved.messages.filter(message => message.role === 'user' || message.role === 'assistant');
    for (const marker of report.turns.flatMap(turn => ['synthetic-' + turn, 'local-answer-' + turn])) {
      assert.equal(history.filter(message => JSON.stringify(message.content).includes(marker)).length, 1, marker);
    }
    report.historyVerified = true;
    report.passed = true;
  } finally {
    try {
      if (runtime) await load('apps/http-api/server/runtime-shutdown.js').shutdownAppRuntime({ ...runtime, reason: 'fixture-completed' });
    } finally {
      provider.closeAllConnections();
      await new Promise(done => provider.close(done));
    }
  }
}
const timer = setTimeout(() => finish(new Error('Fixture timed out')), 150_000);
function finish(error) {
  clearTimeout(timer);
  if (error) { report.passed = false; report.error = String(error.stack ?? error); }
  writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }));
  process.exit(report.passed ? 0 : 1);
}
main().then(() => finish(), finish);
