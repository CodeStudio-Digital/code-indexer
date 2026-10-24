import { randomUUID } from 'node:crypto';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { afterEach, expect, it, vi } from 'vitest';
import { agentV1Runtime as wire, agentV1SessionStore as journal } from '@mcp/agent-runtime-contracts';
import { NativeSessionReader, type VerifiedRuntimePackage } from '@mcp/agent-runtime-host';
import type { ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import type { prepareNativeCoderContext } from '@mcp/code-agent/runtime/native-coder-context.js';
import { identity } from '../../../packages/agent-runtime-host/src/__tests__/attempt-channel-support.js';
import { encodeProviderFrontier, sha256 } from '../../../packages/agent-runtime-host/src/native/ProviderFrontierCodec.js';
import { commitContextChapters, expandContextChapters } from '../../../packages/agent-runtime-host/src/native/NativeContextChapters.js';
import { commitNativeSessionAttachment } from '../../../packages/agent-runtime-host/src/native/NativeSessionAttachments.js';
import { agentV1Artifact as artifact } from '@mcp/agent-runtime-contracts';
import { NativeChildContinuation } from '../workers/native-child-continuation.js';

vi.mock('../native-child-storage.js', () => ({ resolveNativeChildSessionRoot: vi.fn(async () => 'validated-child-root') }));
afterEach(() => vi.restoreAllMocks());
const signal = new AbortController().signal;
const binding = create(wire.ProviderBindingSchema, { effectiveProvider: 'selected-account', effectiveModel: 'selected-model' });
function text(value: string) { return create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.ASSISTANT,
  content: [{ body: { case: 'text', value: { body: { case: 'inlineUtf8', value } } } }] }); }
function imageReference(sessionId: string, bytes: Uint8Array) {
  return create(artifact.ArtifactRefSchema, { artifactId: randomUUID(), ownerSessionId: sessionId, kind: 'image',
    mediaType: 'image/png', byteLength: BigInt(bytes.length), contentSha256: sha256(bytes),
    compression: artifact.ArtifactCompression.NONE, privacyClass: artifact.ArtifactPrivacyClass.CONFIDENTIAL,
    redactionPolicyVersion: 'initial-conversation-v1' });
}
function fixture(I = identity()) {
  const rows: { receipt: journal.CommitSessionRecordReceipt; payload: Uint8Array }[] = [];
  const authority = create(journal.SessionStoreAuthoritySchema, { storageGeneration: journal.StorageGeneration.RUST_FS_V1,
    writerId: I.attemptId, leaseEpoch: 1n });
  function append(kind: journal.SessionRecordKind, operationId: string, payload: Uint8Array) {
    const receipt = create(journal.CommitSessionRecordReceiptSchema, { sessionId: I.sessionId, authority, operationId,
      globalSequence: BigInt(rows.length + 1), kind, durability: journal.SessionDurabilityClass.AUTHORITATIVE,
      payloadBytes: BigInt(payload.length), payloadSha256: sha256(payload), commitSha256: new Uint8Array(32) });
    rows.push({ receipt, payload: Uint8Array.from(payload) }); return receipt;
  }
  const request = async (body: journal.SessionStoreRequest['body']): Promise<journal.SessionStoreResponse['body']> => {
    if (body.case !== 'commitSessionRecord') throw new Error('Unexpected operation');
    return { case: 'commitSessionRecordReceipt', value: append(body.value.kind, body.value.operationId, body.value.encodedPayload) };
  };
  const store = { async list(after: bigint, maximum: number) {
    const records = rows.slice(Number(after), Number(after) + maximum).map(row => row.receipt);
    const next = records.at(-1)?.globalSequence ?? after;
    return { records, nextGlobalSequence: next, complete: next === BigInt(rows.length) };
  }, async read(receipt: journal.CommitSessionRecordReceipt) { return rows[Number(receipt.globalSequence) - 1]!.payload.slice(); } };
  const chapter = async (messages: wire.ProviderMessage[]) => {
    const encodedChapter = toBinary(wire.ProviderContextChapterV1Schema, create(wire.ProviderContextChapterV1Schema, {
      schemaVersion: 1, sessionId: I.sessionId, messages }));
    const reference = create(artifact.ArtifactRefSchema, { artifactId: randomUUID(), ownerSessionId: I.sessionId, kind: 'document',
      mediaType: 'application/vnd.codestudio.context-chapter.v1+protobuf', byteLength: BigInt(encodedChapter.length),
      contentSha256: sha256(encodedChapter), compression: artifact.ArtifactCompression.NONE,
      privacyClass: artifact.ArtifactPrivacyClass.CONFIDENTIAL, redactionPolicyVersion: 'native-context-chapter-v1' });
    const summary = text('bounded summary'); summary.isMeta = true; summary.compactedChapter = reference;
    await commitContextChapters({ request }, 'writer', authority, I.sessionId,
      create(wire.ProviderStartSchema, { messages: [summary], pendingChapters: [{ reference, encodedChapter }] }), signal);
    return summary;
  };
  const finish = (messages: wire.ProviderMessage[]) => {
    append(journal.SessionRecordKind.CHECKPOINT, 'frontier', encodeProviderFrontier(create(wire.ProviderStartSchema, {
      identity: I, binding, operationId: 'provider/1', messages })).payload);
    append(journal.SessionRecordKind.LIFECYCLE_EVENT, 'terminal', toBinary(journal.EngineEventRecordV1Schema,
      create(journal.EngineEventRecordV1Schema, { schemaVersion: 1, identity: I, runtimeInstanceId: 'fixture-runtime',
        localSequence: 1n, body: { case: 'terminal', value: { classification: journal.EngineTerminalClassificationV1.COMPLETED } } })));
  };
  const reader = () => ({ close: vi.fn(async () => undefined), assertCurrent: vi.fn(async () => undefined), store,
    state: { sessionId: I.sessionId, authority, committedRecords: BigInt(rows.length), lastCommitSha256: new Uint8Array(32) },
  } as unknown as NativeSessionReader);
  const input = { context: { sessionId: I.sessionId, agentRunId: I.agentRunId, attemptId: I.attemptId } as ControlPlaneRunContext,
    rootPath: 'root', runtimePackage: {} as VerifiedRuntimePackage, provider: binding.effectiveProvider, model: binding.effectiveModel,
    signal, assertOwner: vi.fn(async () => undefined), allowCompleted: true };
  return { I, request, authority, store, chapter, finish, reader, input };
}

it('copies cumulative chapter attachments to a new child journal so a second cold followup retains the original transcript', async () => {
  const original = fixture(), imageBytes = Buffer.from('historical image inside a compacted chapter');
  const image = imageReference(original.I.sessionId, imageBytes), historical = text('original confirmed history');
  historical.role = wire.ProviderMessageRole.USER;
  historical.content.push(create(wire.ProviderContentBlockSchema, { body: { case: 'attachment', value: image } }));
  await commitNativeSessionAttachment({ request: original.request }, 'original', original.authority, original.I.sessionId,
    image, { read: () => imageBytes }, signal);
  const leaf = await original.chapter([historical]);
  const nested = await original.chapter([leaf, text('later confirmed history')]); original.finish([nested]);
  const successor = fixture({ ...identity(), sessionId: original.I.sessionId });
  vi.spyOn(NativeSessionReader, 'open').mockImplementation(async () => original.reader());
  const source = await NativeChildContinuation.open(original.input);
  try {
    const material = { initialConversationSnapshot: { ref: 'seed' }, providerBinding: binding,
      source: { items: [{ reference: { case: 'snapshot', value: { ref: 'seed' } }, byteLength: 1n }], close: vi.fn(async () => undefined) },
    } as unknown as Awaited<ReturnType<typeof prepareNativeCoderContext>>;
    const sealed = source.prepare(material, successor.I.agentRunId, 'Follow up without replaying effects.');
    const resumed = fromBinary(wire.ProviderResumeContextV1Schema, await sealed.source.readExact(0, 0n, Number(sealed.reference.byteLength)));
    for (const reference of source.artifacts) await commitNativeSessionAttachment({ request: successor.request }, 'successor',
      successor.authority, successor.I.sessionId, reference, source.artifactReader, signal);
    successor.finish(resumed.context!.messages);
    // These are precisely the attachments copied by executeNativeCoder into the new child root.
    expect(source.artifacts.map(reference => reference.artifactId)).toEqual(expect.arrayContaining([
      leaf.compactedChapter!.artifactId, nested.compactedChapter!.artifactId, image.artifactId,
    ]));
    expect(await expandContextChapters(successor.store, successor.I.sessionId, resumed.context!.messages)).toHaveLength(3);
    vi.mocked(NativeSessionReader.open).mockImplementation(async () => successor.reader());
    const reopened = await NativeChildContinuation.open(successor.input);
    expect(Buffer.from(reopened.artifactReader.read(image, 1024, signal))).toEqual(imageBytes);
    reopened.close();
    await sealed.source.close();
  } finally { source.close(); }
});

it('refuses a missing historical attachment that is referenced only inside a compacted chapter', async () => {
  const original = fixture(), image = imageReference(original.I.sessionId, Buffer.from('missing image'));
  const historical = text('historical image'); historical.role = wire.ProviderMessageRole.USER;
  historical.content.push(create(wire.ProviderContentBlockSchema, { body: { case: 'attachment', value: image } }));
  original.finish([await original.chapter([historical])]);
  vi.spyOn(NativeSessionReader, 'open').mockImplementation(async () => original.reader());
  await expect(NativeChildContinuation.open(original.input)).rejects.toThrow('attachments are incomplete');
});
