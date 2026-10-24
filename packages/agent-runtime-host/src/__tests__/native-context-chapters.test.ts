import { createHash, randomUUID } from 'node:crypto';
import { create, toBinary } from '@bufbuild/protobuf';
import { describe, expect, it, vi } from 'vitest';
import { agentV1Runtime as wire, agentV1Artifact as artifact, agentV1SessionStore as journal } from '@mcp/agent-runtime-contracts';
import { commitContextChapters, expandContextChapters } from '../native/NativeContextChapters.js';
import { NativeProviderFrontierWriter } from '../native/NativeProviderFrontierWriter.js';
import type { NativeSessionStoreBridgeClient } from '../native/NativeSessionStoreBridgeClient.js';
import { decodeProviderFrontier } from '../native/ProviderFrontierCodec.js';

function setup() {
  const sessionId = randomUUID();
  const authority = create(journal.SessionStoreAuthoritySchema, { storageGeneration: journal.StorageGeneration.RUST_FS_V1,
    leaseEpoch: 1n, writerId: randomUUID() });
  const original = create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.ASSISTANT,
    content: [{ body: { case: 'text', value: { body: { case: 'inlineUtf8', value: 'Verified result '.repeat(12_000) } } } }] });
  const bytes = toBinary(wire.ProviderContextChapterV1Schema, create(wire.ProviderContextChapterV1Schema,
    { schemaVersion: 1, sessionId, messages: [original] }));
  const ref = create(artifact.ArtifactRefSchema, { artifactId: randomUUID(), ownerSessionId: sessionId, kind: 'document',
    mediaType: 'application/vnd.codestudio.context-chapter.v1+protobuf', byteLength: BigInt(bytes.length),
    contentSha256: createHash('sha256').update(bytes).digest(), compression: artifact.ArtifactCompression.NONE,
    privacyClass: artifact.ArtifactPrivacyClass.CONFIDENTIAL, redactionPolicyVersion: 'native-context-chapter-v1' });
  const summary = create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.ASSISTANT, isMeta: true,
    compactedChapter: ref, content: [{ body: { case: 'text', value: { body: { case: 'inlineUtf8', value: 'Extractive summary' } } } }] });
  const start = create(wire.ProviderStartSchema, { identity: { sessionId, attemptId: authority.writerId, agentRunId: randomUUID() },
    operationId: 'turn:1', binding: { effectiveProvider: 'openai', effectiveModel: 'selected-model' },
    messages: [summary], pendingChapters: [{ reference: ref, encodedChapter: bytes }] });
  const records: Array<{ receipt: journal.CommitSessionRecordReceipt; payload: Uint8Array }> = [];
  const request = vi.fn(async (body: journal.SessionStoreRequest['body']): Promise<journal.SessionStoreResponse['body']> => {
    if (body.case !== 'commitSessionRecord') throw new Error('unexpected request');
    const receipt = create(journal.CommitSessionRecordReceiptSchema, { sessionId, authority,
      operationId: body.value.operationId, globalSequence: BigInt(records.length + 1), kind: body.value.kind,
      durability: body.value.durability, payloadBytes: BigInt(body.value.encodedPayload.length),
      payloadSha256: body.value.expectedPayloadSha256, commitSha256: new Uint8Array(32).fill(1) });
    records.push({ receipt, payload: body.value.encodedPayload.slice() });
    return { case: 'commitSessionRecordReceipt', value: receipt };
  });
  const store = { async list(after: bigint, max: number) {
    const page = records.slice(Number(after), Number(after) + max);
    return { records: page.map(r => r.receipt), nextGlobalSequence: after + BigInt(page.length), complete: Number(after) + page.length >= records.length };
  }, async read(receipt: journal.CommitSessionRecordReceipt) { return records[Number(receipt.globalSequence) - 1]!.payload.slice(); } };
  const commit = () => commitContextChapters({ request }, 'writer', authority, sessionId, start, new AbortController().signal);
  return { sessionId, authority, start, bytes, original, records, request, store, commit };
}

describe('durable native context compaction', () => {
  it('owns decoded argument bytes after the temporary chapter buffer is cleared', async () => {
    const f = setup(), argumentsBytes = Buffer.from('{"path":"original.txt"}');
    const messages = [create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.ASSISTANT, content: [{ body: {
      case: 'toolUse', value: { toolUseId: 'call-1', capabilityName: 'read_file', encodedJsonArguments: argumentsBytes,
        argumentsSha256: createHash('sha256').update(argumentsBytes).digest() },
    } }] }), create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.TOOL, content: [{ body: {
      case: 'toolResult', value: { toolUseId: 'call-1', content: { case: 'inlineUtf8', value: 'verified' } },
    } }] })];
    const bytes = toBinary(wire.ProviderContextChapterV1Schema, create(wire.ProviderContextChapterV1Schema,
      { schemaVersion: 1, sessionId: f.sessionId, messages }));
    const ref = f.start.pendingChapters[0]!.reference!;
    ref.byteLength = BigInt(bytes.length); ref.contentSha256 = createHash('sha256').update(bytes).digest();
    f.start.messages[0]!.compactedChapter = ref;
    f.start.pendingChapters[0]!.encodedChapter = bytes;
    await f.commit();
    const expanded = await expandContextChapters(f.store, f.sessionId, f.start.messages);
    expect(expanded.map(message => toBinary(wire.ProviderMessageSchema, message)))
      .toEqual(messages.map(message => toBinary(wire.ProviderMessageSchema, message)));
  });
  it('commits the lossless chapter before the bounded frontier and expands exact content after reopening', async () => {
    const f = setup();
    const writer = new NativeProviderFrontierWriter({ request: f.request } as unknown as NativeSessionStoreBridgeClient, 'writer', f.sessionId, f.authority);
    await writer.commit(f.start, new AbortController().signal);
    expect(f.records.slice(0, -1).every(r => r.receipt.kind === journal.SessionRecordKind.ATTACHMENT)).toBe(true);
    const last = f.records.at(-1)!;
    expect(last.receipt.kind).toBe(journal.SessionRecordKind.CHECKPOINT);
    const frontier = decodeProviderFrontier(last.payload);
    expect(frontier.value.context!.pendingChapters).toEqual([]);
    expect(last.payload.length).toBeLessThan(2048);
    expect(await expandContextChapters(f.store, f.sessionId, frontier.value.context!.messages)).toEqual([f.original]);
  });

  it('fences the writer on a lost chapter ACK and never publishes or retries a compacted frontier', async () => {
    const f = setup();
    f.request.mockRejectedValueOnce(new Error('ACK lost'));
    const writer = new NativeProviderFrontierWriter({ request: f.request } as unknown as NativeSessionStoreBridgeClient, 'writer', f.sessionId, f.authority);
    await expect(writer.commit(f.start, new AbortController().signal)).rejects.toThrow('ACK lost');
    await expect(writer.commit(f.start, new AbortController().signal)).rejects.toThrow('authority unavailable');
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it('rejects missing, incomplete and corrupt cold chapters without returning a partial history', async () => {
    const f = setup();
    await expect(expandContextChapters(f.store, f.sessionId, f.start.messages)).rejects.toThrow('missing');
    await f.commit(); const last = f.records.pop()!;
    await expect(expandContextChapters(f.store, f.sessionId, f.start.messages)).rejects.toThrow('incomplete');
    f.records.push(last); last.payload[last.payload.length - 1] ^= 1;
    await expect(expandContextChapters(f.store, f.sessionId, f.start.messages)).rejects.toThrow('receipt');
  });

  it('refuses forged ownership or content before any journal mutation', async () => {
    const f = setup(); f.start.pendingChapters[0]!.reference!.ownerSessionId = randomUUID();
    await expect(f.commit()).rejects.toThrow('authority'); expect(f.request).not.toHaveBeenCalled();
    f.start.pendingChapters[0]!.reference!.ownerSessionId = f.sessionId;
    f.bytes[f.bytes.length - 1] ^= 1;
    await expect(f.commit()).rejects.toThrow('digest'); expect(f.request).not.toHaveBeenCalled();
  });

  it('cancellation prevents publishing a replacement and records no chapter', async () => {
    const f = setup(), controller = new AbortController(); controller.abort();
    await expect(commitContextChapters({ request: f.request }, 'writer', f.authority, f.sessionId, f.start, controller.signal)).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
});
