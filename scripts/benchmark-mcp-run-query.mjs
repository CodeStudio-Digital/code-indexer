import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { queryMcpRunMetadata } from '@mcp/session-storage/fs-store/mcp-run-query.js';

const output = resolve(process.argv[2] ?? 'scratch/harness-20261003/mcp-run-query-benchmark.json');
const cases = [];
for (const count of [100, 1000, 10000]) {
  const entries = Array.from({ length: count }, (_, index) => ({ session: {
    id: `session-${index}`, kind: 'coder', storage_scope: { kind: 'project', project_id: 1 }, owner_project_id: 1,
    created_at: new Date(index * 1000).toISOString(), updated_at: new Date(index * 1000).toISOString(),
    metadata: { mcp_agent_run: { schema_version: 1, principal: 'fixture', profile_id: null, agent_id: 'build', task_preview: 'task' } },
  } }));
  for (const mode of ['recent', 'active']) {
    const query = { principal: 'fixture', limit: mode === 'recent' ? 10 : 0,
      ...(mode === 'active' ? { activeSessionIds: new Set(['session-0', 'session-2']) } : {}) };
    for (let i = 0; i < 3; i++) await queryMcpRunMetadata(entries, query);
    const times = []; let result;
    for (let i = 0; i < 20; i++) {
      const started = performance.now(); result = await queryMcpRunMetadata(entries, query);
      times.push(performance.now() - started);
    }
    assert.equal(result.total_count, mode === 'recent' ? count : 2);
    assert.equal(result.items.length, mode === 'recent' ? 10 : 0);
    times.sort((a, b) => a - b);
    cases.push({ sessions: count, mode, samples: times.length, p50Ms: times[9], p95Ms: times[18],
      responseBytes: Buffer.byteLength(JSON.stringify(result)) });
  }
}
const report = { scope: 'Synthetic metadata query only; no catalog bootstrap, disk, HTTP, provider or renderer',
  at: new Date().toISOString(), node: process.version, cases };
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
