import assert from 'node:assert/strict';

/** Delay an existing read-only RPC in an isolated real worker. No production
 * timing flags or alternate runtime are introduced for this shutdown race. */
export async function runPreparationStopFixture({ app, dashboard, post, projectId, setSession, requestCount }) {
  const cases = [];
  for (const scenario of ['stop', 'start-ack-lost', 'drain-ack-lost']) {
    console.log(`Preparation shutdown fixture: ${scenario}`);
    try {
      cases.push(await runCase({ app, dashboard, post, projectId, setSession, requestCount, scenario }));
    } catch (cause) {
      throw new Error(`Preparation shutdown ${scenario}: ${cause instanceof Error ? cause.stack : cause}`, { cause });
    }
  }
  return { cases };
}

async function runCase({ app, dashboard, post, projectId, setSession, requestCount, scenario }) {
  let observationReconnects = 0;
  // Worker teardown can invalidate an in-flight inspector read. Re-observe
  // existing state only; never repeat evict, release, or a messages POST.
  const observe = async reader => {
    for (let attempt = 0; ; attempt++) {
      try { return await app.evaluate(reader); }
      catch (error) {
        if (attempt >= 2 || !String(error).includes('Execution context was destroyed')) throw error;
        observationReconnects++;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  };
  const session = await post('/api/coder/sessions', { project_id: projectId, title: 'Preparation shutdown fixture',
    provider: 'harness-local', model: 'harness-model', agent: 'build', max_turns: 3 });
  setSession(session.id);
  await app.evaluate(async ({ app }, { id, scenario }) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const { getCoderWorkerPool } = require(join(app.getAppPath(), 'dist/apps/http-api/sse/coderWorkerPoolSingleton.js'));
    const pool = getCoderWorkerPool(); const originalEnsure = pool.ensureEntry.bind(pool);
    let release; const gate = new Promise(resolve => { release = resolve; });
    let enter; const entering = new Promise(resolve => { enter = resolve; });
    const originalEvict = pool.evict.bind(pool);
    const probe = globalThis.harnessPreparationStop = { pool, release, entered: false, stopped: false, originalEvict };
    pool.evict = sessionId => {
      const result = originalEvict(sessionId);
      if (sessionId === id) probe.completion = result.then(() => { probe.stopped = true; }, cause => { probe.failure = String(cause); });
      return result;
    };
    pool.ensureEntry = async sessionId => {
      const entry = await originalEnsure(sessionId);
      if (sessionId === id) {
        pool.ensureEntry = originalEnsure; probe.entry = entry;
        const bridge = entry.host.requireBridge(); const original = bridge.handlers.get('mcpExt.snapshot');
        if (!original) throw new Error('MCP snapshot handler unavailable');
        bridge.handle('mcpExt.snapshot', async payload => { probe.entered = true; enter(); await gate; return original(payload); });
        const request = bridge.request.bind(bridge); let lostDrain = false;
        bridge.request = async (type, payload, options) => {
          const result = request(type, payload, options);
          void result.catch(() => {});
          if (type === 'releaseSessionWriter') {
            probe.releaseRequested = true;
            if (scenario === 'drain-ack-lost' && !lostDrain) {
              lostDrain = true; throw Object.assign(new Error('Injected drain ACK lost'), { code: 'request_timeout' });
            }
          }
          if (type === 'runFresh' && scenario !== 'stop') {
            await entering; throw Object.assign(new Error('Injected startup ACK lost'), { code: 'request_timeout' });
          }
          return result;
        };
      }
      return entry;
    };
  }, { id: session.id, scenario });
  const before = requestCount();
  await dashboard.evaluate(id => {
    window.harnessPreparationRequest = fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'HARNESS_PREPARATION_STOP',
        profile: 'full', client_msg_id: 'preparation-stop-one' }) }).then(async response => ({ status: response.status, text: await response.text() }))
      .catch(cause => ({ status: 0, text: String(cause) }));
  }, session.id);
  const deadline = Date.now() + 30_000;
  while (!await observe(() => globalThis.harnessPreparationStop.entered)) {
    assert(Date.now() < deadline, 'worker never entered its preparation RPC');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (scenario === 'stop') await app.evaluate((_electron, id) => {
    void globalThis.harnessPreparationStop.pool.evict(id).catch(() => {});
  }, session.id);
  while (!await observe(() => globalThis.harnessPreparationStop.releaseRequested)) {
    assert(Date.now() < deadline, 'lost startup ACK did not request a drain');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  let retained;
  try {
    await new Promise(resolve => setTimeout(resolve, 350));
    retained = await observe(() => {
      const probe = globalThis.harnessPreparationStop;
      const { join } = process.getBuiltinModule('node:path'); const fs = process.getBuiltinModule('node:fs');
      const path = join(probe.entry.sessionContext.bundlePath, 'events', 'writer.lease');
      const lease = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : null;
      return { stopped: probe.stopped, failure: probe.failure, lease, expectedOwner: probe.entry.sessionContext.writerOwnerId,
        authorityRetained: !!probe.entry.controlPlaneRunContext, running: probe.entry.runInProgress };
    });
    assert.equal(retained.stopped, false, 'worker acknowledged shutdown while preparation was still pending');
    if (scenario === 'drain-ack-lost') {
      assert.match(retained.failure, /drain ACK lost/);
      assert(retained.authorityRetained && retained.running, 'lost drain ACK revoked active authority');
      const uncertain = await dashboard.evaluate(() => window.harnessPreparationRequest);
      assert.equal(uncertain.status, 503); assert(JSON.parse(uncertain.text).code === 'CODER_STARTUP_UNCERTAIN');
    } else assert.equal(retained.failure, undefined);
    assert.equal(retained.lease?.owner_id, retained.expectedOwner, 'writer released before preparation settled');
  } finally {
    await app.evaluate(() => globalThis.harnessPreparationStop.release());
  }
  if (scenario === 'drain-ack-lost') await app.evaluate((_electron, id) => {
    const probe = globalThis.harnessPreparationStop;
    delete probe.failure;
    void probe.pool.evict(id).catch(() => {});
  }, session.id);
  // Observe completion without retaining a remote evaluation across worker
  // teardown. The mutation above is issued exactly once; only reads are polled.
  const drainDeadline = Date.now() + 30_000;
  while (true) {
    const drain = await observe(() => {
      const probe = globalThis.harnessPreparationStop;
      return { stopped: probe.stopped, failure: probe.failure };
    });
    assert(!drain.failure, drain.failure);
    if (drain.stopped) break;
    assert(Date.now() < drainDeadline, 'worker did not confirm shutdown');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await app.evaluate(() => {
    const probe = globalThis.harnessPreparationStop;
    probe.pool.evict = probe.originalEvict;
  });
  const stopped = await dashboard.evaluate(() => window.harnessPreparationRequest);
  assert(!stopped.text.includes('HARNESS_RESULT_OK'));
  assert.equal(requestCount(), before, 'cancelled preparation reached its provider');
  const resumed = await dashboard.evaluate(async id => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'HARNESS_PREPARATION_RECOVERED',
        profile: 'full', client_msg_id: 'preparation-stop-two' }) });
    return { status: response.status, text: await response.text() };
  }, session.id);
  assert.equal(resumed.status, 200); assert(resumed.text.includes('HARNESS_RESULT_OK'), resumed.text.slice(-1800));
  assert.equal(requestCount() - before, 2);
  return { scenario, sessionId: session.id, writerRetainedDuringPreparation: true, cancelledProviderRequests: 0,
    replacementProviderRequests: 2, replacementCompleted: true, cancellationResponseStatus: stopped.status, observationReconnects };
}
