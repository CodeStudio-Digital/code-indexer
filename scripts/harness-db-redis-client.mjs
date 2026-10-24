import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startRespFixture } from './harness-db-resp-fixture.mjs';

const output = resolve(process.argv[2] ?? 'scratch/harness-20261003/native-db-redis-client');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'codestudio-redis-client-'));
process.env.MCP_DATA_DIR = root;
await cp(resolve('scratch/harness-db-drivers/redis-5.8.1'), join(root, 'db-drivers/redis@5.8.1'), { recursive: true });
const { createRedisDriver } = await import('../dist/packages/db-drivers/src/redis.js');
const fixture = await startRespFixture();
let driver;
const report = { root, transport: 'real ioredis 5.8.1; local RESP fixture', cases: [] };
const deadline = setTimeout(() => { console.error('Redis client fixture exceeded 30 seconds'); process.exit(1); }, 30_000);
try {
  driver = await createRedisDriver({ engine: 'redis', host: '127.0.0.1', port: fixture.port, database: '4' });
  await driver.runCommand({ kind: 'keyvalue', args: ['SET', 'normal', 'native-value'] });
  assert(JSON.stringify(await driver.runCommand({ kind: 'keyvalue', args: ['GET', 'normal'] })).includes('native-value'));
  assert.equal(fixture.values.get('4:normal'), 'native-value');
  report.cases.push('saved database and documented raw commands');
  const before = fixture.effects();
  await assert.rejects(driver.runCommand({ kind: 'keyvalue', args: ['SET', 'forbidden', 'value'], payload: { db: 999 } }), /out of range/);
  assert.equal(fixture.effects(), before);
  report.cases.push('failed SELECT cannot write to previous database');
  const pending = driver.runCommand({ kind: 'keyvalue', args: ['GET', 'stall'] });
  const rejected = assert.rejects(pending);
  await fixture.waitFor(() => fixture.events.some(event => event.method === 'GET' && event.args[0] === 'stall'));
  const closeStarted = performance.now(); await driver.close(); await rejected;
  report.stalledCloseMs = performance.now() - closeStarted;
  await fixture.waitFor(() => fixture.clients() === 0);
  report.cases.push('close rejects pending command and drains socket');
  driver = await createRedisDriver({ engine: 'redis', host: '127.0.0.1', port: fixture.port, database: '4' });
  const lost = driver.runCommand({ kind: 'keyvalue', args: ['SET', 'lost-ack', 'once'] });
  const failed = assert.rejects(lost);
  await fixture.waitFor(() => fixture.values.has('4:lost-ack'));
  await failed;
  assert.equal(fixture.events.filter(event => event.method === 'SET' && event.args[0] === 'lost-ack').length, 1);
  assert.equal(fixture.effects(), before + 1);
  report.cases.push('lost write acknowledgement is rejected without SDK replay');
  await driver.close(); await fixture.waitFor(() => fixture.clients() === 0);
  report.remainingClients = fixture.clients(); report.ok = true;
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1; }
finally { await driver?.close(); await fixture.close(); await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); clearTimeout(deadline); }
console.log(JSON.stringify(report, null, 2));
