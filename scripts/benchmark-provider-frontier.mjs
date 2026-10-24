// Run with node --import tsx. Isolated checkpoint codec benchmark; no provider or durable IO.
import { create } from '@bufbuild/protobuf';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { agentV1Runtime as wire } from '@mcp/agent-runtime-contracts';
import { encodeProviderFrontier } from '../packages/agent-runtime-host/src/native/ProviderFrontierCodec.ts';
const report = [];
for (const turns of [100, 1_000, 10_000]) {
 const message = (value, role) => create(wire.ProviderMessageSchema, { role,
   content: [{ body: { case: 'text', value: { body: { case: 'inlineUtf8', value } } } }] });
 const messages = Array.from({ length: turns * 2 }, (_, i) => message(String(i) + ': ' + 'sample context '.repeat(10),
   i % 2 ? wire.ProviderMessageRole.ASSISTANT : wire.ProviderMessageRole.USER));
 const start = create(wire.ProviderStartSchema, { identity: { sessionId: 'session', agentRunId: 'run', attemptId: 'attempt' },
   binding: { effectiveProvider: 'fixture', effectiveModel: 'fixture' }, operationId: 'one', messages });
 const base = encodeProviderFrontier(start).frontier;
 start.operationId = 'two'; start.messages.push(message('next turn', wire.ProviderMessageRole.USER));
 const samples = [];
 let bytes = 0;
 for (let i = 0; i < 23; i++) {
   const began = performance.now(); const result = encodeProviderFrontier(start, base);
   if (i >= 3) samples.push(performance.now() - began);
   bytes = result.payload.length;
 }
 samples.sort((a,b) => a-b);
 report.push({ turns, messages: messages.length, samples: samples.length, p50Ms: samples[10], p95Ms: samples[18], deltaBytes: bytes });
}
const result = { measuredAt: new Date().toISOString(), node: process.version, scope: 'synthetic codec only; no IO/provider; 3 warmups then 20 samples', report };
const output = resolve(process.argv[2] ?? '.tmp/rust-agent-performance/provider-frontier.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
