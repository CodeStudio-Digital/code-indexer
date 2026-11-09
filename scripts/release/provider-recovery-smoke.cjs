/** Run the shipped provider/recovery code without account access or inference. */
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const resources = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const load = name => require(join(resources, 'app.asar', 'dist', 'packages', name));
const report = { resources, checks: [], passed: false };
mkdirSync(output, { recursive: true });

async function main() {
  const { providerTransportError } = load('provider-sdk/src/transport-error.js');
  const { withStreamResilience } = load('provider-sdk/src/stream-resilience.js');
  const { consumeStream } = load('code-agent/src/core/runner/nodes/executing-stream.js');
  const { RecoveringNode } = load('code-agent/src/core/runner/nodes/recovering.js');
  const { createRunContext, resetProviderRetrySequence } = load('code-agent/src/core/runner/machine/context.js');
  const { ChatGPTCodexProvider } = load('code-agent/src/providers/chatgpt.js');
  const interrupted = new TypeError('terminated', { cause: Object.assign(new Error('closed'), { code: 'UND_ERR_SOCKET' }) });
  assert.equal(providerTransportError(interrupted).code, 'UND_ERR_SOCKET');
  const provider = withStreamResilience({
    name: 'fixture', model: 'fixture', setModel() {},
    async *chat() { yield { type: 'text_delta', text: 'complete' }; yield { type: 'done' }; throw interrupted; },
  });
  assert.deepEqual((await consumeStream({ stream: provider.chat({}) })).textBlocks, ['complete']);
  report.checks.push('packaged native-fetch cause and post-terminal teardown');

  const ctx = createRunContext({ opts: { toolContext: {}, provider }, initialTiers: null, emit() {} });
  const event = { kind: 'ProviderError', retryable: true, status: 0, code: 'TIMEOUT', message: 'timeout fixture' };
  for (let index = 0; index < 4; index++) {
    assert.equal((await new RecoveringNode().execute(ctx, event)).kind, 'TurnSucceeded');
    resetProviderRetrySequence(ctx);
  }
  assert.equal((await new RecoveringNode().execute(ctx, { ...event, code: 'UND_ERR_SOCKET' })).kind, 'TurnSucceeded');
  assert.equal(ctx.transportRetriesThisTurn, 1);
  assert.equal(ctx.recovery.get('provider-transport-retry'), 5);
  ctx.transportRetriesThisTurn = 4;
  assert.equal((await new RecoveringNode().execute(ctx, event)).kind, 'Aborted');
  report.checks.push('packaged recovery separates past successes from a bounded retry streak');

  let attempt = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      const send = event => response.write(`data: ${JSON.stringify(event)}\n\n`);
      send({ type: 'response.output_text.delta', delta: 'complete' });
      if (++attempt === 1) {
        const timer = setTimeout(() => response.destroy(), 25);
        response.once('close', () => clearTimeout(timer));
      } else send({ type: 'response.completed', response: { status: 'completed' } });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const live = new ChatGPTCodexProvider({ apiKey: 'local-fixture', baseURL: `http://127.0.0.1:${server.address().port}`, model: 'fixture' });
    const request = { system: 'fixture', messages: [], tools: [] };
    await assert.rejects(consumeStream({ stream: live.chat(request) }), error => providerTransportError(error)?.code === 'UND_ERR_SOCKET');
    assert.deepEqual((await consumeStream({ stream: live.chat(request), idleTimeoutMs: 500 })).textBlocks, ['complete']);
    report.checks.push('packaged Electron HTTP disconnect and protocol completion without socket EOF');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  report.passed = true;
}
main().catch(error => { report.error = String(error.stack || error); process.exitCode = 1; }).finally(() => {
  writeFileSync(join(output, 'provider-recovery-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
});
