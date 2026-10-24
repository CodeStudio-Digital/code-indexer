// Real built-in stdio lifecycle, with an isolated database and no provider calls.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const output = resolve(process.argv[2]);
const runtimeRoot = resolve(process.argv[3] ?? '.');
await mkdir(output, { recursive: true });
for (const name of Object.keys(process.env)) {
  if (/^(MCP_|CODER_)/.test(name) || /(?:API_KEY|ACCESS_TOKEN)$/.test(name)) delete process.env[name];
}
Object.assign(process.env, { MCP_DATA_DIR: join(output, 'data'), MCP_INDEX_DB: join(output, 'data', 'index.db'),
  MCP_RUNTIME_COORDINATION_DIR: join(output, 'coordination'), MCP_DISABLE_TELEMETRY: '1',
  DOTENV_CONFIG_PATH: join(output, 'absent.env') });
const report = { runtimeRoot, startedAt: new Date().toISOString(), processes: [], passed: false };
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (...args) {
  const child = Reflect.apply(originalSpawn, this, args);
  report.processes.push({ pid: child.pid, startedAt: new Date().toISOString() });
  child.once('exit', (code, signal) => Object.assign(report.processes.find(p => p.pid === child.pid), { code, signal, exited: true }));
  return child;
};
syncBuiltinESMExports();
let bridge;
try {
  const { McpToolBridge } = await import(pathToFileURL(join(runtimeRoot, 'dist/packages/code-agent/src/tools/mcp-bridge.js')));
  bridge = new McpToolBridge({ deferConnection: true });
  const start = performance.now();
  const tools = await bridge.listTools({ projectName: 'isolated' });
  report.catalogMs = performance.now() - start;
  assert.equal(tools.length, 33);
  assert.equal(report.processes.length, 0, 'Catalog discovery spawned a subprocess');
  let ownedReads = 0;
  const ctx = { cwd: output, projectName: 'isolated', agentReads: { read: async () => { ownedReads++; return { runs: [] }; } } };
  const owned = await tools.find(t => t.name === 'mcp__list_agent_runs').handler({}, ctx);
  assert(!owned.isError, owned.content); assert.equal(ownedReads, 1);
  assert.equal(report.processes.length, 0, 'Owner-backed query spawned a subprocess');
  report.processesBeforeFirstRemoteRead = report.processes.length;
  const read = tools.find(t => t.name === 'mcp__list_models');
  const started = performance.now();
  const results = await Promise.all([read.handler({ limit: 1 }, ctx), read.handler({ limit: 1 }, ctx)]);
  for (const result of results) { assert(!result.isError, result.content); assert.match(result.content, /"total":/); }
  report.firstRemoteBatchMs = performance.now() - started;
  assert.equal(report.processes.length, 1, 'Concurrent first calls spawned more than one server');
  report.processesAfterFirstRemoteRead = report.processes.length;
  const warm = performance.now();
  assert(!(await read.handler({ limit: 1 }, ctx)).isError);
  report.warmReadMs = performance.now() - warm;
  assert.equal(report.processes.length, 1);
  await bridge.close();
  const closeDeadline = performance.now() + 5000;
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  while (report.processes.some(p => alive(p.pid)) && performance.now() < closeDeadline) await new Promise(r => setTimeout(r, 20));
  assert(report.processes.every(p => !alive(p.pid)), 'MCP server survived owner close');
  assert((await read.handler({ limit: 1 }, ctx)).isError);
  await assert.rejects(bridge.connect(), /closed/);
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.stack : String(error); process.exitCode = 1;
} finally {
  await bridge?.close(); childProcess.spawn = originalSpawn; syncBuiltinESMExports();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
