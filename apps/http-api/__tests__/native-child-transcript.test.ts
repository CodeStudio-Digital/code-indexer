import { randomUUID } from 'node:crypto';
import { create, toBinary } from '@bufbuild/protobuf';
import { afterEach, expect, it, vi } from 'vitest';
import { agentV1Artifact as artifact, agentV1Runtime as wire, agentV1SessionStore as journal } from '@mcp/agent-runtime-contracts';
import { NativeSessionReader, type VerifiedRuntimePackage } from '@mcp/agent-runtime-host';
import type { ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import { identity } from '../../../packages/agent-runtime-host/src/__tests__/attempt-channel-support.js';
import { commitContextChapters } from '../../../packages/agent-runtime-host/src/native/NativeContextChapters.js';
import { encodeProviderFrontier, sha256 } from '../../../packages/agent-runtime-host/src/native/ProviderFrontierCodec.js';
import { engineRecordStorage } from '../../../packages/agent-runtime-host/src/ipc/EngineContentRecord.js';
import { readNativeChildTranscript } from '../native-child-transcript.js';

vi.mock('../native-child-storage.js', () => ({ resolveNativeChildSessionRoot: vi.fn(async () => 'authorized-new-child-journal') }));
afterEach(() => vi.restoreAllMocks());
const text = (value: string, role = wire.ProviderMessageRole.ASSISTANT) => create(wire.ProviderMessageSchema,
  { role, content: [{ body: { case: 'text', value: { body: { case: 'inlineUtf8', value } } } }] });

async function fixture(options: { long?: boolean; foreignSeed?: boolean; missingChapter?: boolean } = {}) {
  const I = identity(), authority = create(journal.SessionStoreAuthoritySchema,
    { storageGeneration: journal.StorageGeneration.RUST_FS_V1, writerId: I.attemptId, leaseEpoch: 1n });
  const rows: Array<{ receipt: journal.CommitSessionRecordReceipt; payload: Uint8Array }> = [];
  const append = (kind: journal.SessionRecordKind, operationId: string, payload: Uint8Array,
    durability = journal.SessionDurabilityClass.AUTHORITATIVE) => {
    const receipt = create(journal.CommitSessionRecordReceiptSchema, { sessionId: I.sessionId, authority, operationId, kind,
      durability, globalSequence: BigInt(rows.length + 1),
      payloadBytes: BigInt(payload.length), payloadSha256: sha256(payload), commitSha256: new Uint8Array(32) });
    rows.push({ receipt, payload: payload.slice() }); return receipt;
  };
  const args = new TextEncoder().encode('{"path":"original-before-resume.txt"}');
  const inherited = [text('Original child task', wire.ProviderMessageRole.USER),
    create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.ASSISTANT, content: [{ body: { case: 'toolUse', value: {
      toolUseId: 'old-read', capabilityName: 'read_file', encodedJsonArguments: args, argumentsSha256: sha256(args),
    } } }] }), create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.TOOL,
      content: [{ body: { case: 'toolResult', value: { toolUseId: 'old-read', content: { case: 'inlineUtf8', value: 'Original confirmed result' } } } }] }),
    ...(options.long ? [text('Long inherited output '.repeat(1000))] : []),
  ];
  const encodedChapter = toBinary(wire.ProviderContextChapterV1Schema, create(wire.ProviderContextChapterV1Schema,
    { schemaVersion: 1, sessionId: I.sessionId, messages: inherited }));
  const reference = create(artifact.ArtifactRefSchema, { artifactId: randomUUID(), ownerSessionId: I.sessionId, kind: 'document',
    contentSha256: sha256(encodedChapter), byteLength: BigInt(encodedChapter.length), compression: artifact.ArtifactCompression.NONE,
    privacyClass: artifact.ArtifactPrivacyClass.CONFIDENTIAL, redactionPolicyVersion: 'native-context-chapter-v1',
    mediaType: 'application/vnd.codestudio.context-chapter.v1+protobuf' });
  const summary = text('Compacted summary must not replace the transcript'); summary.isMeta = true; summary.compactedChapter = reference;
  if (!options.missingChapter) await commitContextChapters({ async request(body) {
    if (body.case !== 'commitSessionRecord') throw new Error('Unexpected writer request');
    return { case: 'commitSessionRecordReceipt', value: append(body.value.kind, body.value.operationId, body.value.encodedPayload) };
  } }, 'new-child-writer', authority, I.sessionId,
  create(wire.ProviderStartSchema, { messages: [summary], pendingChapters: [{ reference, encodedChapter }] }), new AbortController().signal);
  const seed = create(wire.ProviderStartSchema, { identity: options.foreignSeed ? { ...I, attemptId: randomUUID() } : I,
    operationId: 'provider/1', binding: { effectiveProvider: 'fixture', effectiveModel: 'fixture' },
    messages: [summary, text('Continue the resumed child', wire.ProviderMessageRole.USER)] });
  append(journal.SessionRecordKind.CHECKPOINT, 'seed', encodeProviderFrontier(seed).payload);
  const event = (body: journal.EngineEventRecordV1['body']) => {
    const record = create(journal.EngineEventRecordV1Schema, { schemaVersion: 1, identity: I, runtimeInstanceId: 'fixture',
      localSequence: BigInt(rows.length + 1), body });
    const storage = engineRecordStorage(record);
    append(storage.kind, randomUUID(), toBinary(journal.EngineEventRecordV1Schema, record), storage.durability);
  };
  event({ case: 'providerStarted', value: create(journal.EngineProviderStartedRecordV1Schema, { operationId: 'provider/1' }) });
  const newText = new TextEncoder().encode('New result after resume');
  event({ case: 'content', value: create(journal.EngineContentRecordV1Schema, { kind: journal.EngineContentKindV1.TRANSCRIPT,
    contentId: randomUUID(), operationId: 'provider/1', contentSchemaId: 'text/utf8', contentSchemaVersion: 1,
    totalBytes: BigInt(newText.length), contentSha256: sha256(newText), encodedChunk: newText }) });
  append(journal.SessionRecordKind.CHECKPOINT, 'later-frontier', encodeProviderFrontier(create(wire.ProviderStartSchema,
    { ...seed, operationId: 'provider/2', messages: [...seed.messages, text('Do not repeat from later checkpoint')] })).payload);
  event({ case: 'terminal', value: create(journal.EngineTerminalRecordV1Schema, { classification: journal.EngineTerminalClassificationV1.COMPLETED }) });
  const reader = { state: { sessionId: I.sessionId, authority }, close: vi.fn(async () => undefined), assertCurrent: vi.fn(async () => undefined),
    store: { async list(after: bigint, maximum: number) {
      const records = rows.slice(Number(after), Number(after) + maximum).map(row => row.receipt), next = records.at(-1)?.globalSequence ?? after;
      return { records, nextGlobalSequence: next, complete: next === BigInt(rows.length) };
    }, async read(receipt: journal.CommitSessionRecordReceipt) { return rows[Number(receipt.globalSequence) - 1]!.payload.slice(); } },
  } as unknown as NativeSessionReader;
  vi.spyOn(NativeSessionReader, 'open').mockResolvedValue(reader);
  const input = { context: { sessionId: I.sessionId, agentRunId: I.agentRunId, attemptId: I.attemptId } as ControlPlaneRunContext,
    rootPath: 'root', runtimePackage: {} as VerifiedRuntimePackage, maxChars: 2000, signal: new AbortController().signal,
    assertOwner: vi.fn(async () => undefined) };
  return { input, reader };
}

it('includes inherited compacted calls/results once and current events after a child resume', async () => {
  const f = await fixture(), digest = await readNativeChildTranscript(f.input);
  expect(digest).toContain('Original child task'); expect(digest).toContain('original-before-resume.txt');
  expect(digest.match(/Tool read_file/g)).toHaveLength(1); expect(digest).toContain('Original confirmed result');
  expect(digest).toContain('Continue the resumed child'); expect(digest).toContain('New result after resume');
  expect(digest).not.toContain('Compacted summary'); expect(digest).not.toContain('Do not repeat from later checkpoint');
  expect(digest.length).toBeLessThanOrEqual(2000); expect(f.reader.close).toHaveBeenCalledOnce();
  expect(f.input.assertOwner).toHaveBeenCalledTimes(2); expect(f.reader.assertCurrent).toHaveBeenCalledOnce();
});

it('keeps inherited history within the requested digest budget', async () => {
  const f = await fixture({ long: true }), digest = await readNativeChildTranscript(f.input);
  expect(digest.length).toBeLessThanOrEqual(2000); expect(digest).toContain('Transcript digest truncated');
  expect(digest).toContain('Original confirmed result'); expect(f.reader.close).toHaveBeenCalledOnce();
});

it.each([{ foreignSeed: true }, { missingChapter: true }])('rejects an invalid inherited frontier instead of returning incomplete history: %j', async options => {
  const f = await fixture(options);
  await expect(readNativeChildTranscript(f.input)).rejects.toThrow(); expect(f.reader.close).toHaveBeenCalledOnce();
});

it('rejects a stalled seed cursor and closes the reader', async () => {
  const f = await fixture();
  vi.spyOn(f.reader.store, 'list').mockResolvedValue({ records: [], nextGlobalSequence: 0n, complete: false });
  await expect(readNativeChildTranscript(f.input)).rejects.toThrow('cursor stalled');
  expect(f.reader.close).toHaveBeenCalledOnce();
});
