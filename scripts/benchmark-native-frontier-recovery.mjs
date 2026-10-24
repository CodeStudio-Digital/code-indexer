// Read-only comparison over the SAME authority-checked immutable native journal.
// Run with node --import tsx. The compiled baseline must predate the source change.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fromBinary } from '@bufbuild/protobuf';
import { agentV1Runtime as wire } from '../dist/packages/agent-runtime-contracts/src/index.js';
import { verifyRuntimePackage } from '../dist/packages/agent-runtime-host/src/packaging/RuntimePackageVerifier.js';
import { NativeSessionReader } from '../dist/packages/agent-runtime-host/src/native/NativeSessionReader.js';
import { inspectProviderFrontier as baseline } from '../dist/packages/agent-runtime-host/src/native/NativeProviderFrontierRecovery.js';
import { inspectProviderFrontier as candidate } from '../packages/agent-runtime-host/src/native/NativeProviderFrontierRecovery.ts';

const [rootArgument, sessionId, expectedManifest, outputArgument] = process.argv.slice(2);
assert(rootArgument && sessionId && outputArgument && /^[a-f0-9]{64}$/.test(expectedManifest), 'explicit fixture paths and native manifest SHA are required');
const output = resolve(outputArgument); await mkdir(output, { recursive: true });
const candidateOnly = process.argv.includes('--candidate-only');
const baselineSource = await readFile('dist/packages/agent-runtime-host/src/native/NativeProviderFrontierRecovery.js', 'utf8');
const candidateSource = await readFile('packages/agent-runtime-host/src/native/NativeProviderFrontierRecovery.ts', 'utf8');
assert(candidateOnly || !baselineSource.includes('latestProviderCheckpointBase'),
  'Compiled code already contains the candidate: restore the archived baseline or use --candidate-only');
const packageRoot = resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc');
const manifest = JSON.parse(await readFile(join(packageRoot, 'manifest.json'), 'utf8'));
const runtime = await verifyRuntimePackage(packageRoot, { schemaVersion: 1, targetTriple: manifest.targetTriple,
  buildId: manifest.buildId, manifestSha256: expectedManifest });
const began = performance.now();
const reader = await NativeSessionReader.open(runtime, { rootPath: resolve(rootArgument), sessionId });
const report = { scope: 'Same immutable physical journal; deterministic checkpoint fixture, no real provider/tool turns',
  comparisonMode: candidateOnly ? 'Candidate only; compare with separately recorded physical baseline' : 'Paired baseline/candidate',
  baselineSourceSha256: createHash('sha256').update(baselineSource).digest('hex'),
  candidateSourceSha256: createHash('sha256').update(candidateSource).digest('hex'),
  sessionId, snapshotId: reader.snapshotId, buildId: manifest.buildId, validatedSnapshotMs: performance.now() - began, results: [] };
try {
  const receipts = []; let cursor = 0n;
  for (;;) {
    const page = await reader.store.list(cursor, 256); receipts.push(...page.records);
    if (page.complete) break;
    cursor = page.nextGlobalSequence;
  }
  assert(receipts.length > 0 && receipts.length <= 65_536);
  report.committedRecords = receipts.length;
  const tail = fromBinary(wire.ProviderFrontierRecordV1Schema, await reader.store.read(receipts.at(-1)));
  const agentRunId = tail.frontier.agentRunId;
  const counts = [...new Set([100, 1_000, receipts.length].filter(count => count <= receipts.length))];
  for (const count of counts) {
    const sample = { records: count, runs: [] };
    const committed = fromBinary(wire.ProviderFrontierRecordV1Schema, await reader.store.read(receipts[count - 1]));
    const expectedDigest = Buffer.from(committed.frontierSha256).toString('hex');
    assert.equal(expectedDigest.length, 64);
    // Reverse the order on the second pass so warm payload-cache advantage is shared.
    const versions = candidateOnly ? [['candidate', candidate], ['candidate', candidate]]
      : [['baseline', baseline], ['candidate', candidate], ['candidate', candidate], ['baseline', baseline]];
    for (const [name, inspect] of versions) {
      let payloadReads = 0; let payloadBytes = 0; let metadataPages = 0;
      const store = {
        async list(after, maximum) {
          metadataPages++;
          // Preserve actual native pagination/authority checks, cap this historical view.
          const page = await reader.store.list(after, Math.min(maximum, count - Number(after)));
          assert(page.records.every(receipt => receipt.globalSequence <= BigInt(count)));
          return { ...page, complete: page.nextGlobalSequence === BigInt(count) };
        },
        async read(receipt) {
          payloadReads++; const bytes = await reader.store.read(receipt); payloadBytes += bytes.length; return bytes;
        },
      };
      const started = performance.now();
      const recovered = await inspect(store, sessionId, agentRunId, count);
      const durationMs = performance.now() - started;
      assert.equal(recovered.status, 'resumable');
      assert.equal(recovered.frontier.context.messages.length, count * 2);
      const digest = createHash('sha256').update(recovered.encodedFrontier).digest('hex');
      assert.equal(digest, expectedDigest, 'recovered bytes must match the committed complete frontier exactly');
      sample.runs.push({ name, durationMs, payloadReads, payloadBytes, metadataPages, frontierSha256: digest });
      await reader.assertCurrent();
      console.log(JSON.stringify({ records: count, ...sample.runs.at(-1) }));
      await writeFile(join(output, 'progress.json'), JSON.stringify({ ...report, current: sample }, null, 2));
    }
    report.results.push(sample);
  }
  report.passed = true;
} catch (error) { report.failure = String(error); process.exitCode = 1; }
finally {
  try { await reader.close(); } catch (error) { report.closeFailure = String(error); process.exitCode = 1; }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
