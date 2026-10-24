// Run: node --import tsx scripts/harness-performance.mjs [report.json]
// Synthetic local work only: no provider, credentials, real session or mutation tool.
import { writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { SessionWriter, computeRequestHash } from '@mcp/session-storage/session-writer.js';
import { ConversationProjection } from '@mcp/session-storage/fs-store/conversation-codec.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { dispatchTools } from '@mcp/code-agent/core/runner/nodes/executing-dispatch.js';
import { fileURLToPath } from 'node:url';

const round = (ms) => Math.round(ms * 1000) / 1000;
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, p50Ms: round(sorted[Math.floor(sorted.length * .5)]),
    p95Ms: round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .95) - 1)]) };
};
const payload = (seq) => ({ schema_version: 1, type: 'coder.turn', request_key: `request-${seq}`,
  messages: [{ schema_version: 1, id: `10000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    seq, role: 'assistant', content: [{ type: 'text', text: `Synthetic turn ${seq}` }],
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    is_meta: false, selected_skill_ids: [], artifact_refs: [] }],
  message_patches: [], tool_calls: [], goal_mutations: [],
});

async function persistence(turns) {
  const root = await mkdtemp(join(tmpdir(), 'codestudio-harness-perf-'));
  let writer;
  try {
    await mkdir(join(root, 'events'));
    let previousHash = null;
    const lines = [];
    for (let seq = 1; seq <= turns; seq++) {
      const value = payload(seq);
      const unsigned = { schema_version: 1, seq, operation_id: `operation-${seq}`,
        request_hash: computeRequestHash(value), committed_at: '2026-10-03T00:00:00.000Z',
        prev_hash: previousHash, payload: value, artifacts: [] };
      previousHash = computeRequestHash(unsigned);
      lines.push(JSON.stringify({ ...unsigned, hash: previousHash }));
    }
    await writeFile(join(root, 'conversation.jsonl'), `${lines.join('\n')}\n`);
    const openedAt = performance.now();
    writer = await SessionWriter.open({ bundlePath: root, sessionId: randomUUID() });
    let applications = 0;
    const projection = { create: () => new ConversationProjection(), apply: (state, commit) => {
      applications++; state.apply(commit);
    } };
    await writer.readProjection(projection);
    const coldOpenAndProjectionMs = round(performance.now() - openedAt);
    const warm = [];
    for (let i = 1; i <= 20; i++) {
      const started = performance.now();
      const value = payload(turns + i);
      await writer.commitTurn({ operation_id: `warm-${i}`, request_hash: computeRequestHash(value), payload: value });
      const state = await writer.readProjection(projection);
      if (state.highestMessageSeq !== turns + i) throw new Error('projection mismatch');
      warm.push(performance.now() - started);
    }
    if (applications !== turns + 20) throw new Error('historical records were reapplied');
    return { turns, coldOpenAndProjectionMs, warmCommitAndRead: stats(warm), applications };
  } finally {
    await writer?.close();
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('codestudio-harness-perf-')) {
      throw new Error('unsafe temporary cleanup');
    }
    await rm(root, { recursive: true, force: true });
  }
}


async function dispatch(delays = [['fast', 20], ['slow', 200]]) {
  const registry = new ToolRegistry();
  let running = 0;
  let maximumConcurrency = 0;
  const results = [];
  for (const [name, delay] of delays) registry.register({ name, description: name,
    source: 'native', mutates: false, parallelSafe: true, executionClass: 'read',
    parameters: { type: 'object', properties: {} }, handler: async () => {
      maximumConcurrency = Math.max(maximumConcurrency, ++running);
      await new Promise((resolve) => setTimeout(resolve, delay));
      running--; return { content: name };
    } });
  const start = performance.now();
  await dispatchTools({ registry, toolContext: { cwd: process.cwd(), projectName: 'synthetic' }, turn: 1,
    dupCalls: new Map(), toolUses: delays.map(([name]) => ({ id: name, name, input: {} })),
    onToolResult: (result) => results.push({ name: result.name, visibleMs: round(performance.now() - start) }),
  });
  return { runtime: 'legacy_ts', maximumConcurrency, batchMs: round(performance.now() - start), results };
}

const report = { schemaVersion: 1, measuredAt: new Date().toISOString(), node: process.version,
  platform: process.platform, architecture: process.arch,
  head: execFileSync('git', ['-c', 'safe.directory=D:/MCP', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  synthetic: true, persistence: [], streaming: [], dispatch: null };
for (const count of [100, 1_000, 10_000]) report.persistence.push(await persistence(count));
report.streaming = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx',
  fileURLToPath(new URL('../apps/dashboard/performance/stream-projector.ts', import.meta.url))],
  { encoding: 'utf8', windowsHide: true }));
report.dispatch = await dispatch();
report.independentReadBatch = await dispatch(Array.from({ length: 4 }, (_, index) => [`read_${index}`, 100]));
const json = JSON.stringify(report, null, 2);
if (process.argv[2]) await writeFile(process.argv[2], `${json}\n`);
console.log(json);
