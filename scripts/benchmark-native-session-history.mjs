// Physical Rust journal + production frontier writer; deterministic history,
// no model, tool execution or user profile. Requires an already verified build.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { create, fromBinary } from '@bufbuild/protobuf';
import { agentV1Common, agentV1Runtime as wire, agentV1SessionStore as store } from '../dist/packages/agent-runtime-contracts/src/index.js';
import { verifyRuntimePackage } from '../dist/packages/agent-runtime-host/src/packaging/RuntimePackageVerifier.js';
import { loadNativeHostBridge } from '../dist/packages/agent-runtime-host/src/native/NativeHostBridgeLoader.js';
import { NativeDurableEngineEventCommitter } from '../dist/packages/agent-runtime-host/src/native/NativeDurableEngineEventCommitter.js';
import { NativeSessionReader } from '../dist/packages/agent-runtime-host/src/native/NativeSessionReader.js';
import { inspectProviderFrontier } from '../dist/packages/agent-runtime-host/src/native/NativeProviderFrontierRecovery.js';

const output = resolve(process.argv[2]);
const expectedManifest = process.argv[3];
assert(/^[a-f0-9]{64}$/.test(expectedManifest), 'expected manifest SHA-256 is required');
const packageRoot = resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc');
const manifest = JSON.parse(await readFile(join(packageRoot, 'manifest.json'), 'utf8'));
const runtime = await verifyRuntimePackage(packageRoot, { schemaVersion: 1, targetTriple: manifest.targetTriple,
  buildId: manifest.buildId, manifestSha256: expectedManifest });
await mkdir(output, { recursive: true });
const rootPath = join(output, 'sessions'); await mkdir(rootPath, { recursive: true });
const sessionId = process.argv[4] || randomUUID(); let agentRunId = randomUUID();
let authority = create(store.SessionStoreAuthoritySchema, {
  storageGeneration: store.StorageGeneration.RUST_FS_V1, writerId: randomUUID(), leaseEpoch: 1n,
});
const identity = create(agentV1Common.AttemptIdentitySchema, { sessionId, agentRunId,
  rootAgentRunId: agentRunId, commandId: randomUUID(), attemptId: randomUUID(),
  correlationId: randomUUID(), executorOwnerId: 'benchmark/history', fencingEpoch: 1n });
let start = create(wire.ProviderStartSchema, { identity, operationId: 'initial',
  binding: { effectiveProvider: 'local-fixture', effectiveModel: 'deterministic-history' } });
const report = { schemaVersion: 1, startedAt: new Date().toISOString(),
  scope: 'Physical Rust journal, synthetic conversation checkpoints; no model, tools or full turn engine',
  buildId: manifest.buildId, expectedManifest, sessionId, results: [] };
const signal = new AbortController().signal;
const times = [];
let writer;
const now = performance.now();
try {
  let committed = 0;
  if (process.argv[4]) {
    // Resume only this deterministic fixture after its owning Job has exited.
    // Native open validates the full chain first; never infer ACK success from files.
    const reader = await NativeSessionReader.open(runtime, { rootPath, sessionId });
    try {
      let cursor = 0n; let last;
      for (;;) {
        const page = await reader.store.list(cursor, 256);
        assert(page.records.every(receipt => receipt.kind === store.SessionRecordKind.CHECKPOINT));
        committed += page.records.length; last = page.records.at(-1) ?? last;
        if (page.complete) break;
        cursor = page.nextGlobalSequence;
      }
      assert(last && committed < 10_000);
      const tail = fromBinary(wire.ProviderFrontierRecordV1Schema, await reader.store.read(last));
      assert.equal(tail.operationId, `history/${committed}`);
      agentRunId = tail.frontier.agentRunId;
      const { inspectProviderFrontier: recover } = await import('../packages/agent-runtime-host/src/native/NativeProviderFrontierRecovery.ts');
      const recovered = await recover(reader.store, sessionId, agentRunId, committed);
      assert.equal(recovered.status, 'resumable');
      assert.equal(recovered.frontier.providerBinding.effectiveModel, 'deterministic-history');
      assert.equal(recovered.frontier.context.messages.length, committed * 2);
      authority = reader.state.authority;
      start = create(wire.ProviderStartSchema, { ...recovered.frontier.context,
        identity: { ...identity, sessionId, agentRunId, rootAgentRunId: agentRunId, attemptId: recovered.frontier.sourceAttemptId },
        operationId: 'resume', binding: recovered.frontier.providerBinding });
      report.resumedAfterValidatedRecord = committed;
      await reader.assertCurrent();
    } finally { await reader.close(); }
  }
  writer = await NativeDurableEngineEventCommitter.open(loadNativeHostBridge(runtime), {
    instanceId: randomUUID(), rootId: 'history-benchmark', rootPath,
    maximumFrameBytes: 17 * 1024 * 1024, sessionId, authority,
    limits: create(store.SessionStoreLimitsSchema, { maxRecords: 1_000_000n,
      maxPayloadBytes: 16n * 1024n * 1024n, maxAuthorityTransitions: 100_000n }),
    openIdempotencyKey: randomUUID(), nowUnixMs: () => BigInt(Date.now()), timeoutMs: 30_000n,
  });
  for (let turn = committed + 1; turn <= 10_000; turn++) {
    start.operationId = `history/${turn}`;
    for (const role of [wire.ProviderMessageRole.USER, wire.ProviderMessageRole.ASSISTANT]) {
      start.messages.push(create(wire.ProviderMessageSchema, { role,
        content: [{ body: { case: 'text', value: { body: { case: 'inlineUtf8', value: `History fixture ${turn}: ${role}` } } } }] }));
    }
    const began = performance.now(); await writer.commitProviderFrontier(start, signal);
    times.push(performance.now() - began);
    if (turn % 1000 === 0) {
      report.committedTurns = turn;
      console.log(JSON.stringify({ committedTurns: turn, elapsedMs: performance.now() - now }));
      await writeFile(join(output, 'progress.json'), JSON.stringify(report, null, 2));
    }
    if (![100, 1_000, 10_000].includes(turn)) continue;
    const opening = performance.now();
    const reader = await NativeSessionReader.open(runtime, { rootPath, sessionId, authority });
    try {
      const validatedSnapshotMs = performance.now() - opening;
      const scan = performance.now();
      let cursor = 0n; let count = 0; let pages = 0;
      for (;;) {
        const page = await reader.store.list(cursor, 128); pages++;
        count += page.records.length; cursor = page.nextGlobalSequence;
        if (page.complete) break;
      }
      const pageAllReceiptsMs = performance.now() - scan;
      assert.equal(count, turn);
      const recoveryStarted = performance.now();
      const recovered = await inspectProviderFrontier(reader.store, sessionId, agentRunId, turn + 1);
      assert.equal(recovered.status, 'resumable');
      assert.equal(recovered.frontier.context.messages.length, 2 * turn);
      const recent = times.slice(-20).sort((a, b) => a - b);
      report.results.push({ turns: turn, records: count, messages: 2 * turn, pages,
        recentSamples: recent.length, warmCommitP50Ms: recent[10], warmCommitP95Ms: recent[18],
        validatedSnapshotMs, pageAllReceiptsMs, frontierRecoveryMs: performance.now() - recoveryStarted });
      console.log(JSON.stringify(report.results.at(-1)));
    } finally { await reader.close(); }
  }
  report.passed = true;
} catch (error) { report.failure = String(error); process.exitCode = 1; }
finally {
  try { await writer?.close(); } catch (error) { report.closeFailure = String(error); process.exitCode = 1; } report.elapsedMs = performance.now() - now;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
