import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Runs in an owned packaged Electron process. Uses real Rust journal writers
 * and readers; it never starts a provider or touches the installed profile. */
export async function runPackagedChildChapters({ candidate, output, phase }) {
  const archive = join(candidate, 'resources', 'app.asar');
  const load = path => import(pathToFileURL(join(archive, 'dist', path)).href);
  const { create, fromBinary, toBinary } = await import(pathToFileURL(join(archive, 'node_modules/@bufbuild/protobuf/dist/esm/index.js')).href);
  const { agentV1Common: common, agentV1Runtime: wire, agentV1Artifact: artifact, agentV1SessionStore: journal } =
    await load('packages/agent-runtime-contracts/src/index.js');
  const { verifyRuntimePackage, NativeSessionReader } = await load('packages/agent-runtime-host/src/index.js');
  const { loadNativeHostBridge } = await load('packages/agent-runtime-host/src/native/NativeHostBridgeLoader.js');
  const { NativeDurableEngineEventCommitter } = await load('packages/agent-runtime-host/src/native/NativeDurableEngineEventCommitter.js');
  const { expandContextChapters } = await load('packages/agent-runtime-host/src/native/NativeContextChapters.js');
  const { NativeChildContinuation } = await load('apps/http-api/workers/native-child-continuation.js');
  const { resolveNativeChildSessionRoot } = await load('apps/http-api/native-child-storage.js');
  const { readNativeChildTranscript } = await load('apps/http-api/native-child-transcript.js');
  const runtimePackage = await verifyRuntimePackage(join(candidate, 'resources/native-agent-runtime/x86_64-pc-windows-msvc'),
    JSON.parse(await readFile(join(archive, 'dist/apps/electron/native-agent-runtime-integrity.json'), 'utf8')));
  const rootPath = join(output, 'chapter-sessions'), signal = new AbortController().signal;
  await mkdir(rootPath, { recursive: true });
  const binding = create(wire.ProviderBindingSchema, { effectiveProvider: 'openai', effectiveModel: 'fixture' });
  const digest = bytes => createHash('sha256').update(bytes).digest();
  const text = value => create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.ASSISTANT,
    content: [{ body: { case: 'text', value: { body: { case: 'inlineUtf8', value } } } }] });
  const contextOf = id => ({ sessionId: id.sessionId, agentRunId: id.agentRunId, attemptId: id.attemptId });
  const openContinuation = context => NativeChildContinuation.open({ context, rootPath, runtimePackage,
    provider: binding.effectiveProvider, model: binding.effectiveModel, signal, assertOwner() {}, allowCompleted: true });
  if (phase === 'child-chapters-read') {
    const saved = JSON.parse(await readFile(join(output, 'child-chapters-write.json'), 'utf8'));
    const source = await openContinuation(saved.context);
    try {
      const image = fromBinary(artifact.ArtifactRefSchema, Uint8Array.from(Buffer.from(saved.imageBase64, 'base64')));
      assert.equal(Buffer.from(source.artifactReader.read(image, 1024, signal)).toString(), 'historical image bytes');
      assert.equal(source.artifacts.length, 3);
      const transcript = await readNativeChildTranscript({ context: saved.context, rootPath, runtimePackage, signal, assertOwner() {} });
      for (const marker of ['ORIGINAL_CONFIRMED_HISTORY', 'LATER_CONFIRMED_HISTORY', 'FOLLOWUP_WITHOUT_REPLAY']) assert(transcript.includes(marker), transcript);
      await writeFile(join(output, 'child-chapters-read.json'), JSON.stringify({ passed: true, coldProcess: true,
        nestedChapters: 2, historicalImages: 1, inheritedTranscript: true, pid: process.pid }, null, 2));
    } finally { source.close(); }
    return;
  }
  assert.equal(phase, 'child-chapters-write');
  const sessionId = randomUUID(), rootAgentRunId = randomUUID();
  const identity = () => create(common.AttemptIdentitySchema, { sessionId, commandId: randomUUID(), agentRunId: randomUUID(),
    attemptId: randomUUID(), executorOwnerId: 'packaged-chapter-fixture', fencingEpoch: 1n, correlationId: randomUUID(),
    rootAgentRunId, ownerAgentRunId: rootAgentRunId });
  async function writer(id) {
    return NativeDurableEngineEventCommitter.open(loadNativeHostBridge(runtimePackage), { instanceId: randomUUID(),
      rootId: 'native-product-sessions', rootPath: await resolveNativeChildSessionRoot(rootPath, id, true),
      maximumFrameBytes: 17 * 1024 * 1024, sessionId, authority: create(journal.SessionStoreAuthoritySchema, {
        storageGeneration: journal.StorageGeneration.RUST_FS_V1, writerId: id.attemptId, leaseEpoch: 1n }),
      limits: create(journal.SessionStoreLimitsSchema, { maxRecords: 1_000_000n, maxPayloadBytes: 16n * 1024n * 1024n, maxAuthorityTransitions: 100_000n }),
      openIdempotencyKey: randomUUID(), nowUnixMs: () => BigInt(Date.now()), timeoutMs: 30_000n });
  }
  async function finish(store, id, messages) {
    await store.commitProviderFrontier(create(wire.ProviderStartSchema, { identity: id, binding, operationId: randomUUID(), messages }), signal);
    const record = create(journal.EngineEventRecordV1Schema, { schemaVersion: 1, identity: id, runtimeInstanceId: randomUUID(),
      localSequence: 1n, body: { case: 'terminal', value: { classification: journal.EngineTerminalClassificationV1.COMPLETED } } });
    await store.commit({ identity: id, record, expectedPayloadSha256: digest(toBinary(journal.EngineEventRecordV1Schema, record)) });
  }
  const originalId = identity(), original = await writer(originalId);
  const imageBytes = Buffer.from('historical image bytes');
  const image = create(artifact.ArtifactRefSchema, { artifactId: randomUUID(), ownerSessionId: sessionId, kind: 'image', mediaType: 'image/png',
    byteLength: BigInt(imageBytes.length), contentSha256: digest(imageBytes), compression: artifact.ArtifactCompression.NONE,
    privacyClass: artifact.ArtifactPrivacyClass.CONFIDENTIAL, redactionPolicyVersion: 'initial-conversation-v1' });
  try {
    await original.commitAttachment(image, { read: () => imageBytes }, signal);
    const history = text('ORIGINAL_CONFIRMED_HISTORY'); history.role = wire.ProviderMessageRole.USER;
    history.content.push(create(wire.ProviderContentBlockSchema, { body: { case: 'attachment', value: image } }));
    const chapter = async messages => {
      const encodedChapter = toBinary(wire.ProviderContextChapterV1Schema, create(wire.ProviderContextChapterV1Schema, { schemaVersion: 1, sessionId, messages }));
      const reference = create(artifact.ArtifactRefSchema, { artifactId: randomUUID(), ownerSessionId: sessionId, kind: 'document',
        mediaType: 'application/vnd.codestudio.context-chapter.v1+protobuf', byteLength: BigInt(encodedChapter.length),
        contentSha256: digest(encodedChapter), compression: artifact.ArtifactCompression.NONE,
        privacyClass: artifact.ArtifactPrivacyClass.CONFIDENTIAL, redactionPolicyVersion: 'native-context-chapter-v1' });
      const summary = text('Bounded summary'); summary.isMeta = true; summary.compactedChapter = reference;
      await original.commitProviderFrontier(create(wire.ProviderStartSchema, { identity: originalId, binding, operationId: randomUUID(),
        messages: [summary], pendingChapters: [{ reference, encodedChapter }] }), signal);
      return summary;
    };
    const leaf = await chapter([history]), nested = await chapter([leaf, text('LATER_CONFIRMED_HISTORY')]);
    await finish(original, originalId, [nested]);
  } finally { await original.close(); }
  const source = await openContinuation(contextOf(originalId)), successorId = identity();
  try {
    const sealed = source.prepare({ initialConversationSnapshot: { ref: 'seed' }, providerBinding: binding,
      source: { items: [{ reference: { case: 'snapshot', value: { ref: 'seed' } }, byteLength: 1n }], async close() {} } },
    successorId.agentRunId, 'FOLLOWUP_WITHOUT_REPLAY');
    try {
      const resumed = fromBinary(wire.ProviderResumeContextV1Schema, await sealed.source.readExact(0, 0n, Number(sealed.reference.byteLength)));
      const successor = await writer(successorId);
      try {
        assert.equal(source.artifacts.length, 3);
        for (const reference of source.artifacts) await successor.commitAttachment(reference, source.artifactReader, signal);
        await finish(successor, successorId, resumed.context.messages);
      } finally { await successor.close(); }
      const reader = await NativeSessionReader.open(runtimePackage, { rootPath: await resolveNativeChildSessionRoot(rootPath, successorId), sessionId });
      try { assert.equal((await expandContextChapters(reader.store, sessionId, resumed.context.messages, signal)).length, 3); }
      finally { await reader.close(); }
    } finally { await sealed.source.close(); }
  } finally { source.close(); }
  await writeFile(join(output, 'child-chapters-write.json'), JSON.stringify({ passed: true, context: contextOf(successorId),
    imageBase64: Buffer.from(toBinary(artifact.ArtifactRefSchema, image)).toString('base64'), pid: process.pid }, null, 2));
}
