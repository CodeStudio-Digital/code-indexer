// node --import tsx scripts/benchmark-provider-frontier-writer.mjs <report.json>
// In-memory durable-receipt fixture: measures writer CPU, without disk or provider.
import { create } from '@bufbuild/protobuf';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { agentV1Runtime as wire, agentV1SessionStore as store } from '@mcp/agent-runtime-contracts';
import { NativeProviderFrontierWriter } from '../packages/agent-runtime-host/src/native/NativeProviderFrontierWriter.ts';

const results = [];
for (const turns of [100, 1_000, 10_000]) {
  const message = (text, role = wire.ProviderMessageRole.USER) => create(wire.ProviderMessageSchema, {
    role, content: [{ body: { case: 'text', value: { body: { case: 'inlineUtf8', value: text } } } }],
  });
  const start = create(wire.ProviderStartSchema, {
    identity: { sessionId: 'session', agentRunId: 'run', attemptId: 'attempt' }, operationId: 'initial',
    binding: { effectiveProvider: 'fixture', effectiveModel: 'fixture' },
    messages: Array.from({ length: turns * 2 }, (_, index) => message(`${index}: ${'sample context '.repeat(10)}`,
      index % 2 ? wire.ProviderMessageRole.ASSISTANT : wire.ProviderMessageRole.USER)),
  });
  const authority = create(store.SessionStoreAuthoritySchema, {
    storageGeneration: store.StorageGeneration.RUST_FS_V1, leaseEpoch: 1n, writerId: 'writer',
  });
  let sequence = 0n;
  let payloadBytes = 0;
  const writer = new NativeProviderFrontierWriter({ async request(body) {
    const record = body.value;
    payloadBytes = record.encodedPayload.length;
    return { case: 'commitSessionRecordReceipt', value: create(store.CommitSessionRecordReceiptSchema, {
      sessionId: 'session', operationId: record.operationId, authority, kind: record.kind,
      durability: record.durability, globalSequence: ++sequence, payloadBytes: BigInt(payloadBytes),
      payloadSha256: record.expectedPayloadSha256,
    }) };
  } }, 'writer', 'session', authority);
  const signal = new AbortController().signal;
  await writer.commit(start, signal);
  const samples = [];
  for (let index = 0; index < 23; index++) {
    start.operationId = `turn/${index}`;
    start.messages.push(message(`next ${index}`));
    const began = performance.now();
    await writer.commit(start, signal);
    if (index >= 3) samples.push(performance.now() - began);
  }
  samples.sort((a, b) => a - b);
  results.push({ turns, initialMessages: turns * 2, samples: samples.length,
    p50Ms: samples[10], p95Ms: samples[18], lastDeltaBytes: payloadBytes });
}
const report = { measuredAt: new Date().toISOString(), node: process.version,
  scope: 'Synthetic writer CPU only; fake durable receipt; no disk/provider; 3 warmups and 20 samples', results };
const output = resolve(process.argv[2] ?? '.tmp/rust-agent-performance/provider-frontier-writer.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
