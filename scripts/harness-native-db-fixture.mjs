import assert from 'node:assert/strict';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { startRespFixture } from './harness-db-resp-fixture.mjs';

export async function startNativeDatabaseFixture(isolated) {
  await cp(resolve('scratch/harness-db-drivers/redis-5.8.1'),
    join(isolated, 'data/db-drivers/redis@5.8.1'), { recursive: true });
  return startRespFixture();
}

export function nativeDatabaseDelta(body, results) {
  const scenario = JSON.stringify(body.messages.filter(message => message.role === 'user'))
    .match(/HARNESS_NATIVE_DATABASE_(COMPLETE|SQLCANCEL|REDISCANCEL|UNKNOWN)/)?.[1];
  if (!scenario) return;
  const sql = (statement, extra = {}) => ['db_query', { connection: 'sqlite-fixture', sql: statement, ...extra }];
  const redis = args => ['db_command', { connection: 'redis-fixture', command: { args } }];
  const call = calls => ({ role: 'assistant', tool_calls: calls.map(([name, args], index) => ({ index,
    id: `harness-database-${results.length}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
  for (const result of results) assert(!/db_\w+ failed|Tool '.*' failed|outcome is unknown|not wired|not installed/i.test(JSON.stringify(result.content)), JSON.stringify(result.content));
  if (!results.length) {
    for (const name of ['db_list', 'db_schema', 'db_query', 'db_command']) assert(body.tools.some(tool => tool.function?.name === name), `native catalog lost ${name}`);
    if (scenario === 'SQLCANCEL') return call([sql('SELECT count(*) FROM items')]);
    if (scenario === 'REDISCANCEL') return call([redis(['PING'])]);
    if (scenario === 'UNKNOWN') return call([redis(['SET', 'lost-ack', 'once']),
      ['create_file', { path: 'forbidden-after-database.txt', content: 'must not execute' }]]);
    return call([['db_list', {}], ['db_schema', { connection: 'sqlite-fixture' }]]);
  }
  assert.notEqual(scenario, 'UNKNOWN', 'provider resumed after uncertain database write');
  if (scenario === 'SQLCANCEL') return call([sql('WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 1000000000) SELECT sum(n) FROM t')]);
  if (scenario === 'REDISCANCEL') return call([redis(['GET', 'stall'])]);
  if (results.length === 2) {
    assert(JSON.stringify(results[0].content).includes('redis-fixture'));
    assert(JSON.stringify(results[1].content).includes('items'));
    return call([['db_schema', { connection: 'sqlite-fixture', table: 'items' }],
      sql('INSERT INTO items(value) VALUES (?)', { params: ['native-row'] }), redis(['SET', 'normal', 'native-redis'])]);
  }
  if (results.length === 5) return call([
    sql('SELECT value FROM items ORDER BY id', { max_rows: 2 }),
    sql("UPDATE items SET value = value || '-updated' RETURNING id", { max_rows: 1 }), redis(['GET', 'normal'])]);
  if (results.length === 8) {
    assert(JSON.stringify(results[7].content).includes('native-redis'), 'Redis GET lost the write');
    return call([sql('SELECT value FROM items ORDER BY id'), redis(['DEL', 'normal'])]);
  }
  assert.equal(results.length, 10, 'database tool result lost or replayed');
  assert(JSON.stringify(results[8].content).includes('native-row-updated'), 'SQLite write/RETURNING did not complete');
  return { role: 'assistant', content: 'HARNESS_NATIVE_DATABASE_OK' };
}

async function installConnections(app, { projectId, root, port }) {
  return app.evaluate(({ app }, { projectId, root, port }) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const { CodeIndexDB } = require(join(app.getAppPath(), 'dist/packages/store/src/db.js'));
    const { DbClientStore } = require(join(app.getAppPath(), 'dist/packages/store/src/db-client-store.js'));
    const { routedFeatureDbPath } = require(join(app.getAppPath(), 'dist/packages/store/src/project-db/routed-path.js'));
    const Database = require('better-sqlite3'), path = join(root, 'fixture.sqlite');
    const borrowed = new Database(path);
    borrowed.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items(value) VALUES ('first'),('second'),('third')");
    global.__harnessBorrowedDatabase = borrowed;
    const central = new CodeIndexDB(process.env.MCP_INDEX_DB), featurePath = routedFeatureDbPath(central.raw(), projectId);
    const feature = featurePath ? new Database(featurePath) : central.raw();
    try {
      const store = new DbClientStore(feature);
      store.createConnection({ project_id: projectId, label: 'sqlite-fixture', engine: 'sqlite', file_path: path });
      store.createConnection({ project_id: projectId, label: 'redis-fixture', engine: 'redis', host: '127.0.0.1', port, database_name: '4' });
      return { sqlitePath: path, featurePath };
    } finally { if (featurePath) feature.close(); central.close(); }
  }, { projectId, root, port });
}

export async function runNativeDatabaseFixture({ app, root, dashboard, post, setSession, fixture }) {
  const cases = [];
  for (const scenario of ['COMPLETE', 'SQLCANCEL', 'REDISCANCEL', 'UNKNOWN']) {
    console.log(`Native database fixture: ${scenario}`);
    const caseRoot = join(dirname(root), `database-${scenario.toLowerCase()}`); await mkdir(caseRoot);
    const project = await post('/api/projects', { name: `Database ${scenario}`, root_path: caseRoot });
    const connections = await installConnections(app, { projectId: project.id, root: caseRoot, port: fixture.port });
    const session = await post('/api/coder/sessions', { project_id: project.id, title: `Native database ${scenario}`,
      provider: 'harness-local', model: 'harness-model', agent: 'build', max_turns: 8 });
    setSession(session.id);
    await post(`/api/coder/sessions/${session.id}/tool-permission-mode`, { mode: 'unrestricted' }, 'PATCH');
    const result = await dashboard.evaluate(async ({ id, scenario }) => {
      const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({ content: `HARNESS_NATIVE_DATABASE_${scenario}`, profile: 'full', max_turns: 8 }) });
      if (!response.ok || !response.body) throw new Error(`database run ${response.status}: ${await response.text()}`);
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let stream = '', buffer = '', aborted = false, starts = 0, cancelAckMs, approvals = 0;
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        const text = decoder.decode(next.value, { stream: true }); stream += text; buffer += text;
        const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() ?? '';
        for (const frame of frames) {
          if (/^event: tool_approval_request$/m.test(frame)) {
            const data = JSON.parse(frame.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n'));
            if (data.approvalKind !== 'database_write' || !['sqlite-fixture', 'redis-fixture'].includes(data.input?.connection)) throw new Error('Unexpected fixture approval');
            const approved = await fetch(`mcp://app/api/coder/sessions/${id}/tool-approval`, { method: 'POST',
              headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool_use_id: data.toolUseId, approved: true }) });
            if (!approved.ok) throw new Error('Database fixture approval failed'); approvals++; continue;
          }
          if (!scenario.endsWith('CANCEL') || aborted || !/^event: tool_call_start$/m.test(frame)) continue;
          starts++;
          if (starts !== 2) continue; // First call warms the actual driver connection.
          await new Promise(resolve => setTimeout(resolve, 200));
          const before = performance.now();
          const cancelled = await fetch(`mcp://app/api/coder/sessions/${id}/abort`, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: '{}' });
          cancelAckMs = performance.now() - before;
          if (!cancelled.ok) throw new Error('Database cancellation failed'); aborted = true;
        }
      }
      return { stream, aborted, cancelAckMs, approvals };
    }, { id: session.id, scenario });
    if (scenario === 'COMPLETE') assert(result.stream.includes('HARNESS_NATIVE_DATABASE_OK'), result.stream.slice(-7000));
    else if (scenario.endsWith('CANCEL')) {
      assert(result.aborted, result.stream.slice(-7000));
      if (scenario === 'REDISCANCEL') assert(fixture.events.some(event => event.method === 'GET' && event.args[0] === 'stall'), 'cancel fixture never reached Redis');
    } else {
      assert(result.stream.includes('TOOL_OUTCOME_UNKNOWN'), result.stream.slice(-7000));
      await assert.rejects(readFile(join(caseRoot, 'forbidden-after-database.txt')), { code: 'ENOENT' });
      await assertNativeDatabaseRecovery(dashboard, session.id);
      assert.equal(fixture.events.filter(event => event.method === 'SET' && event.args[0] === 'lost-ack').length, 1);
    }
    await fixture.waitFor(() => fixture.clients() === 0);
    const borrowed = await app.evaluate(() => {
      const database = global.__harnessBorrowedDatabase;
      try { return database.prepare('SELECT value FROM items ORDER BY id').all(); }
      finally { database.close(); delete global.__harnessBorrowedDatabase; }
    });
    assert.equal(borrowed.length, scenario === 'COMPLETE' ? 4 : 3);
    if (scenario === 'COMPLETE') assert(borrowed.every(row => row.value.endsWith('-updated')), 'RETURNING row cap interrupted a mutation');
    cases.push({ scenario, sessionId: session.id, root: caseRoot, connections, cancelAckMs: result.cancelAckMs,
      approvals: result.approvals, remainingRedisClients: fixture.clients(), borrowedConnectionPreserved: true });
    console.log(`Native database fixture passed: ${scenario}`);
  }
  return { cases, scope: 'SQLite real file and native process; real ioredis client against local RESP fixture' };
}

export async function assertNativeDatabaseRecovery(dashboard, sessionId) {
  const result = await dashboard.evaluate(async id => {
    const history = await fetch(`mcp://app/api/coder/sessions/${id}?full=1`).then(response => response.json());
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/continue`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000), body: JSON.stringify({ max_auto_continues: 0 }) });
    return { history, continued: await response.text() };
  }, sessionId);
  assert(JSON.stringify(result.history.messages).includes('"effect_outcome":"unknown"'), 'database history lost uncertain outcome');
  assert(result.continued.includes('TOOL_OUTCOME_UNKNOWN'), 'database continuation repeated an uncertain write');
  return { uncertainOutcomeRetained: true, continuationBlocked: true };
}
