import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { startNativeHttpFixture, assertNativeHttpRecovery } from './harness-native-http-fixture.mjs';

export async function startNativeApiFixture() { return startNativeHttpFixture(); }

export function nativeApiDelta(body, fixture) {
  const start = body.messages.findLastIndex(message => message.role === 'user' && /HARNESS_NATIVE_API_/.test(JSON.stringify(message.content)));
  if (start < 0) return;
  const prompt = JSON.stringify(body.messages[start].content);
  const scenario = prompt.match(/HARNESS_NATIVE_API_(COMPLETE|FOLLOWUP|CANCEL|SCRIPT|UNKNOWN)/)?.[1];
  if (!scenario) return;
  const results = body.messages.slice(start + 1).filter(message => message.role === 'tool');
  const text = result => typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
  const call = calls => ({ role: 'assistant', tool_calls: calls.map(([name, args], index) => ({ index,
    id: `harness-api-${scenario}-${results.length}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
  for (const name of ['api_import_openapi', 'api_list_requests', 'api_get_request', 'api_update_request', 'api_mark_verified', 'api_run_request', 'api_run_collection']) {
    assert(body.tools.some(tool => tool.function?.name === name), `missing native API tool ${name}`);
  }
  for (const result of results) assert(!/request failed|not found|not wired|Tool '.*' failed|script runtime unavailable/i.test(text(result)), text(result).slice(0, 500));
  if (scenario !== 'COMPLETE') {
    const ids = prompt.match(/ids=(\d+),(\d+),(\d+)/).slice(1).map(Number);
    if (!results.length) {
      if (scenario === 'UNKNOWN') return call([['api_run_collection', { collectionId: ids[0], includeMutating: true }],
        ['create_file', { path: 'forbidden-after-api.txt', content: 'must not run' }]]);
      return call([['api_run_request', { requestId: ids[1] }]]);
    }
    assert.notEqual(scenario, 'UNKNOWN', 'provider resumed after an uncertain API write');
    if (scenario === 'FOLLOWUP') { assert(text(results[0]).includes('AUTHENTICATED')); return { role: 'assistant', content: 'HARNESS_NATIVE_API_FOLLOWUP_OK' }; }
    return call([['api_run_request', { requestId: ids[2] }]]);
  }
  if (!results.length) return call([['api_import_openapi', { specPath: 'openapi.json' }]]);
  const collectionId = Number(text(results[0]).match(/collection #(\d+)/)?.[1]); assert(collectionId > 0);
  if (results.length === 1) return call([['api_list_requests', { collectionId, limit: 2 }], ['api_list_requests', { collectionId, limit: 2, offset: 2 }]]);
  const ids = new Map([...`${text(results[1])}\n${text(results[2])}`.matchAll(/#(\d+) (?:GET|POST) (\/\w+)/g)].map(match => [match[2], Number(match[1])]));
  assert.equal(ids.size, 3); fixture.completeIds = { collectionId, me: ids.get('/me') };
  if (results.length === 3) return call([['api_get_request', { requestId: ids.get('/login') }],
    ['api_update_request', { requestId: ids.get('/login'), body: '{"fixture":true}', bodyKind: 'json' }],
    ...[...ids.values()].map(requestId => ['api_mark_verified', { requestId, expectedStatus: 200 }])]);
  if (results.length === 8) return call([['api_run_request', { requestId: ids.get('/login') }], ['api_run_request', { requestId: ids.get('/me') }]]);
  if (results.length === 10) { assert(text(results[9]).includes('AUTHENTICATED')); return call([['api_run_collection', { collectionId }], ['api_run_collection', { collectionId, includeMutating: true }]]); }
  assert.equal(results.length, 12); assert(text(results[10]).includes('2 passed')); assert(text(results[11]).includes('3 passed'));
  return { role: 'assistant', content: 'HARNESS_NATIVE_API_COMPLETE_OK' };
}

async function seed(app, { projectId, url, scenario }) {
  return app.evaluate(({ app }, { projectId, url, scenario }) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const { CodeIndexDB } = require(join(app.getAppPath(), 'dist/packages/store/src/db.js'));
    const { ApiClientStore } = require(join(app.getAppPath(), 'dist/packages/store/src/api-client-store.js'));
    const { routedFeatureDbPath } = require(join(app.getAppPath(), 'dist/packages/store/src/project-db/routed-path.js'));
    const Database = require('better-sqlite3');
    const central = new CodeIndexDB(process.env.MCP_INDEX_DB), path = routedFeatureDbPath(central.raw(), projectId);
    const feature = path ? new Database(path) : central.raw();
    try {
      const store = new ApiClientStore(feature);
      store.upsertEnvironment({ project_id: projectId, name: 'fixture', base_url: url, is_default: true });
      if (scenario === 'COMPLETE') return [0, 0, 0];
      const col = store.createCollection({ project_id: projectId, name: scenario });
      const first = store.createRequest({ collection_id: col.id, name: 'first', method: scenario === 'UNKNOWN' ? 'POST' : 'GET',
        path_template: scenario === 'UNKNOWN' ? '/lost-ack' : '/health' });
      const second = store.createRequest({ collection_id: col.id, name: 'second', method: 'GET',
        path_template: scenario === 'CANCEL' ? '/stall' : '/health',
        pre_request_script: scenario === 'SCRIPT' ? 'while (true) {}' : null });
      store.markVerified(first.id, 200, null); store.markVerified(second.id, 200, null);
      return [col.id, first.id, second.id];
    } finally { if (path) feature.close(); central.close(); }
  }, { projectId, url, scenario });
}

export async function runNativeApiFixture({ app, root, dashboard, post, setSession, fixture }) {
  const cases = []; let complete;
  for (const scenario of ['COMPLETE', 'FOLLOWUP', 'CANCEL', 'SCRIPT', 'UNKNOWN']) {
    console.log(`Native API fixture: ${scenario}`);
    let id, caseRoot, ids;
    if (scenario === 'FOLLOWUP') { id = complete.sessionId; caseRoot = complete.root; ids = [fixture.completeIds.collectionId, fixture.completeIds.me, 0]; }
    else {
      caseRoot = join(dirname(root), `api-${scenario.toLowerCase()}`); await mkdir(caseRoot);
      await writeFile(join(caseRoot, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'fixture', version: '1' }, paths: {
        '/health': { get: { responses: { 200: { description: 'ok' } } } },
        '/login': { post: { responses: { 200: { description: 'ok' } } } },
        '/me': { get: { responses: { 200: { description: 'ok' } } } },
      } }));
      const project = await post('/api/projects', { name: `API ${scenario}`, root_path: caseRoot });
      ids = await seed(app, { projectId: project.id, url: fixture.url, scenario });
      const session = await post('/api/coder/sessions', { project_id: project.id, title: `Native API ${scenario}`,
        provider: 'harness-local', model: 'harness-model', agent: 'api', max_turns: 9 });
      id = session.id; await post(`/api/coder/sessions/${id}/tool-permission-mode`, { mode: 'unrestricted' }, 'PATCH');
    }
    setSession(id);
    const result = await dashboard.evaluate(async ({ id, scenario, ids }) => {
      const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000),
        body: JSON.stringify({ content: `HARNESS_NATIVE_API_${scenario} ids=${ids.join(',')}`, profile: 'full', max_turns: 9 }) });
      if (!response.ok || !response.body) throw new Error(`API fixture ${response.status}: ${await response.text()}`);
      const reader = response.body.getReader(), decoder = new TextDecoder(); let stream = '', buffer = '', starts = 0, aborted = false, cancelAckMs;
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        const text = decoder.decode(next.value, { stream: true }); stream += text; buffer += text;
        const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() ?? '';
        for (const frame of frames) {
          if (!['CANCEL', 'SCRIPT'].includes(scenario) || aborted || !/^event: tool_call_start$/m.test(frame) || ++starts !== 2) continue;
          await new Promise(resolve => setTimeout(resolve, 200));
          const before = performance.now();
          const cancelled = await fetch(`mcp://app/api/coder/sessions/${id}/abort`, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: '{}' });
          cancelAckMs = performance.now() - before; if (!cancelled.ok) throw new Error('API cancellation failed'); aborted = true;
        }
      }
      return { stream, aborted, cancelAckMs };
    }, { id, scenario, ids });
    if (['CANCEL', 'SCRIPT'].includes(scenario)) { assert(result.aborted, result.stream.slice(-5000)); if (scenario === 'CANCEL') assert.equal(fixture.stalled(), 1); }
    else if (scenario === 'UNKNOWN') {
      assert(result.stream.includes('TOOL_OUTCOME_UNKNOWN'), result.stream.slice(-5000)); assert.equal(fixture.effects(), 1);
      await assert.rejects(readFile(join(caseRoot, 'forbidden-after-api.txt')), { code: 'ENOENT' }); await assertNativeHttpRecovery(dashboard, id);
    } else assert(result.stream.includes(`HARNESS_NATIVE_API_${scenario}_OK`), result.stream.slice(-5000));
    await fixture.assertDrained();
    const evidence = { scenario, sessionId: id, root: caseRoot, remainingSockets: fixture.sockets(), cancelAckMs: result.cancelAckMs };
    cases.push(evidence); if (scenario === 'COMPLETE') complete = evidence;
  }
  return { cases, effectCount: fixture.effects() };
}

export const assertNativeApiRecovery = assertNativeHttpRecovery;
