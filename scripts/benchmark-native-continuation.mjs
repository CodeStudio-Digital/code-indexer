// Receipt-authenticated in-memory fixture, not physical Rust, real turns or a
// provider benchmark. Run BEFORE rebuilding dist to compare the frozen baseline.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { create, toBinary } from '@bufbuild/protobuf';
import { agentV1Common, agentV1Runtime as wire, agentV1SessionStore as journal } from '../packages/agent-runtime-contracts/src/index.ts';
import { encodeProviderFrontier, sha256 } from '../packages/agent-runtime-host/src/native/ProviderFrontierCodec.ts';
import { engineRecordStorage } from '../packages/agent-runtime-host/src/ipc/EngineContentRecord.ts';
import { inspectNativeContinuation as candidate } from '../apps/http-api/workers/native-coder-continuation.ts';
import { inspectNativeContinuation as baseline } from '../dist/apps/http-api/workers/native-coder-continuation.js';

const output = resolve(process.argv[2]); await mkdir(output, { recursive: true });
const paths = ['dist/apps/http-api/workers/native-coder-continuation.js',
  'apps/http-api/workers/native-coder-continuation.ts',
  'packages/agent-runtime-host/src/native/NativeProviderCheckpointIndex.ts',
  'packages/agent-runtime-host/src/native/NativeEngineEventRecovery.ts'];
const report = { schemaVersion: 1, startedAt: new Date().toISOString(),
  scope: 'Synthetic in-memory receipts and checkpoints; no disk journal, model, tools or complete engine turns',
  inputs: await Promise.all(paths.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') }))),
  results: [] };
const I = create(agentV1Common.AttemptIdentitySchema, { sessionId: randomUUID(), agentRunId: randomUUID(),
  rootAgentRunId: randomUUID(), commandId: randomUUID(), attemptId: randomUUID(),
  executorOwnerId: 'continuation-benchmark', fencingEpoch: 1n, correlationId: randomUUID() });
const rows = []; const messages = []; let previous;
function append(payload, storage) {
  const receipt = create(journal.CommitSessionRecordReceiptSchema, { ...storage, sessionId: I.sessionId,
    operationId: `record/${rows.length}`, globalSequence: BigInt(rows.length + 1),
    payloadBytes: BigInt(payload.length), payloadSha256: sha256(payload), commitSha256: new Uint8Array(32) });
  rows.push({ receipt, payload });
}
function event(body) {
  const value = create(journal.EngineEventRecordV1Schema, { schemaVersion: 1, identity: I,
    runtimeInstanceId: 'continuation-benchmark', localSequence: BigInt(rows.length + 1), body });
  append(toBinary(journal.EngineEventRecordV1Schema, value), engineRecordStorage(value));
}
function reader() {
  const counts = { payloadReads: 0, checkpointReads: 0, bytesRead: 0, pages: 0, authorityChecks: 0 };
  return { counts, state: { sessionId: I.sessionId, authority: { writerId: I.attemptId },
    committedRecords: BigInt(rows.length), lastCommitSha256: new Uint8Array(32) },
    async assertCurrent() { counts.authorityChecks++; }, store: {
      async list(after, maximum) { counts.pages++;
        const records = rows.slice(Number(after), Number(after) + maximum).map(row => row.receipt);
        const next = records.at(-1)?.globalSequence ?? after;
        return { records, nextGlobalSequence: next, complete: next === BigInt(rows.length) }; },
      async read(receipt) { const bytes = rows[Number(receipt.globalSequence) - 1].payload;
        counts.payloadReads++; counts.bytesRead += bytes.length;
        if (receipt.kind === journal.SessionRecordKind.CHECKPOINT) counts.checkpointReads++;
        return bytes; },
    } };
}
try {
  for (let turn = 1; turn <= 10_000; turn++) {
    const operationId = `provider/${turn}`;
    event({ case: 'providerStarted', value: { operationId } });
    messages.push(create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.USER,
      content: [{ body: { case: 'text', value: { body: { case: 'inlineUtf8', value: `Synthetic turn ${turn}` } } } }] }));
    const encoded = encodeProviderFrontier(create(wire.ProviderStartSchema, { identity: I, operationId, messages,
      binding: { effectiveProvider: 'fixture', effectiveModel: 'fixture' } }), (turn - 1) % 32 ? previous : undefined);
    previous = encoded.frontier;
    append(encoded.payload, { kind: journal.SessionRecordKind.CHECKPOINT, durability: journal.SessionDurabilityClass.AUTHORITATIVE });
    if (turn % 1000 === 0) console.log(JSON.stringify({ preparedCheckpoints: turn }));
    if (![100, 1_000, 10_000].includes(turn)) continue;
    event({ case: 'terminal', value: { classification: journal.EngineTerminalClassificationV1.INTERRUPTED } });
    for (const resume of [false, true]) {
      let expected;
      for (const [name, inspect] of [['baseline', baseline], ['candidate', candidate]]) {
        const input = reader(); const started = performance.now(); const proof = await inspect(input, resume);
        const result = { checkpoints: turn, resume, implementation: name, elapsedMs: performance.now() - started, ...input.counts };
        assert.equal(input.counts.authorityChecks, 1);
        if (name === 'baseline') expected = proof; else assert.deepEqual(proof, expected);
        if (name === 'candidate') assert(input.counts.checkpointReads <= (resume ? 64 : 0));
        report.results.push(result); console.log(JSON.stringify(result));
        await writeFile(join(output, 'progress.json'), JSON.stringify(report, null, 2));
      }
    }
    rows.pop();
  }
  report.passed = true;
} catch (error) { report.failure = String(error); process.exitCode = 1; }
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: report.passed, failure: report.failure }));
