import { createHash, randomUUID } from 'node:crypto';
import { clone, create, toBinary } from '@bufbuild/protobuf';
import { expect, it, vi } from 'vitest';
import { agentV1Runtime as wire, agentV1Artifact as artifact, agentV1SessionStore as journal } from '@mcp/agent-runtime-contracts';
import { commitContextChapters, expandContextChapters } from '../native/NativeContextChapters.js';
import { NativeSessionAttachments } from '../native/NativeSessionAttachments.js';

function fixture() {
  const sessionId = randomUUID(), records: Array<{ receipt: journal.CommitSessionRecordReceipt; bytes: Uint8Array }> = [];
  const authority = create(journal.SessionStoreAuthoritySchema, { storageGeneration: journal.StorageGeneration.RUST_FS_V1,
    leaseEpoch: 1n, writerId: randomUUID() });
  const request = async (body: journal.SessionStoreRequest['body']): Promise<journal.SessionStoreResponse['body']> => {
    if (body.case !== 'commitSessionRecord') throw new Error('Unexpected operation');
    const value = body.value;
    const receipt = create(journal.CommitSessionRecordReceiptSchema, { sessionId, authority, operationId: value.operationId,
      globalSequence: BigInt(records.length + 1), kind: value.kind, durability: value.durability,
      payloadBytes: BigInt(value.encodedPayload.length), payloadSha256: value.expectedPayloadSha256, commitSha256: new Uint8Array(32).fill(1) });
    records.push({ receipt, bytes: value.encodedPayload.slice() }); return { case: 'commitSessionRecordReceipt', value: receipt };
  };
  const store = { async list(after: bigint, max: number) {
    const page = records.slice(Number(after), Number(after) + max);
    return { records: page.map(row => row.receipt), nextGlobalSequence: after + BigInt(page.length), complete: Number(after) + page.length >= records.length };
  }, async read(receipt: journal.CommitSessionRecordReceipt) { return records[Number(receipt.globalSequence) - 1]!.bytes.slice(); } };
  const commit = async (messages: wire.ProviderMessage[], id = randomUUID()) => {
    const bytes = toBinary(wire.ProviderContextChapterV1Schema, create(wire.ProviderContextChapterV1Schema, { schemaVersion: 1, sessionId, messages }));
    const reference = create(artifact.ArtifactRefSchema, { artifactId: id, ownerSessionId: sessionId, kind: 'document',
      mediaType: 'application/vnd.codestudio.context-chapter.v1+protobuf', byteLength: BigInt(bytes.length),
      contentSha256: createHash('sha256').update(bytes).digest(), compression: artifact.ArtifactCompression.NONE,
      privacyClass: artifact.ArtifactPrivacyClass.CONFIDENTIAL, redactionPolicyVersion: 'native-context-chapter-v1' });
    const summary = text('summary'); summary.isMeta = true; summary.compactedChapter = reference;
    await commitContextChapters({ request }, 'writer', authority, sessionId,
      create(wire.ProviderStartSchema, { messages: [summary], pendingChapters: [{ reference, encodedChapter: bytes }] }), new AbortController().signal);
    return summary;
  };
  return { sessionId, store, commit, records };
}
function text(value: string) { return create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.ASSISTANT,
  content: [{ body: { case: 'text', value: { body: { case: 'inlineUtf8', value } } } }] }); }

it('expands 160 cumulative nested chapters iteratively in order and retains owned protobuf argument bytes', async () => {
  const f = fixture(), argumentsBytes = Buffer.from('{"path":"retained.txt"}');
  const original = [create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.ASSISTANT, content: [{ body: {
    case: 'toolUse', value: { toolUseId: 'original-call', capabilityName: 'read_file', encodedJsonArguments: argumentsBytes,
      argumentsSha256: createHash('sha256').update(argumentsBytes).digest() },
  } }] }), create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.TOOL, content: [{ body: {
    case: 'toolResult', value: { toolUseId: 'original-call', content: { case: 'inlineUtf8', value: 'original result' } },
  } }] })];
  let top = await f.commit(original); const expected = [...original];
  for (let n = 1; n < 160; n++) { const tail = text(`turn ${n}`); top = await f.commit([top, tail]); expected.push(tail); }
  const output = await expandContextChapters(f.store, f.sessionId, [top]);
  expect(output.map(message => toBinary(wire.ProviderMessageSchema, message))).toEqual(expected.map(message => toBinary(wire.ProviderMessageSchema, message)));
  const use = output[0]!.content[0]!.body; expect(use.case).toBe('toolUse');
  if (use.case === 'toolUse') expect(Buffer.from(use.value.encodedJsonArguments).toString()).toBe(argumentsBytes.toString());
});

it('allows repeated sibling references but rejects a path cycle before following its forged inner digest', async () => {
  const f = fixture(), leaf = await f.commit([text('same chapter')]);
  const siblings = await f.commit([leaf, leaf]);
  expect(await expandContextChapters(f.store, f.sessionId, [siblings])).toEqual([text('same chapter'), text('same chapter')]);
  const loopId = randomUUID(), inner = clone(wire.ProviderMessageSchema, leaf); inner.compactedChapter!.artifactId = loopId;
  const cyclic = await f.commit([inner], loopId);
  await expect(expandContextChapters(f.store, f.sessionId, [cyclic])).rejects.toThrow('cycle');
});

it('retains owned argument bytes when the attachment reader supplies an actual Node Buffer', async () => {
  const f = fixture(), args = Buffer.from('{"path":"buffer-owned.txt"}');
  const messages = [create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.ASSISTANT, content: [{ body: {
    case: 'toolUse', value: { toolUseId: 'buffer-call', capabilityName: 'read_file', encodedJsonArguments: args,
      argumentsSha256: createHash('sha256').update(args).digest() },
  } }] }), create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.TOOL, content: [{ body: {
    case: 'toolResult', value: { toolUseId: 'buffer-call', content: { case: 'inlineUtf8', value: 'kept' } },
  } }] })];
  const top = await f.commit(messages), originalRead = NativeSessionAttachments.prototype.read;
  let temporary: Buffer | undefined;
  const spy = vi.spyOn(NativeSessionAttachments.prototype, 'read').mockImplementation(function(this: NativeSessionAttachments, ...input) {
    temporary = Buffer.from(originalRead.apply(this, input)); return temporary;
  });
  try {
    const output = await expandContextChapters(f.store, f.sessionId, [top]);
    expect(Buffer.isBuffer(temporary)).toBe(true); expect(temporary!.every(byte => byte === 0)).toBe(true);
    expect(output.map(message => toBinary(wire.ProviderMessageSchema, message))).toEqual(messages.map(message => toBinary(wire.ProviderMessageSchema, message)));
  } finally { spy.mockRestore(); }
});

it('rejects missing chapters, foreign ownership and cancellation without partial output', async () => {
  const f = fixture(), original = await f.commit([text('preserved')]);
  const missing = clone(wire.ProviderMessageSchema, original); missing.compactedChapter!.artifactId = randomUUID();
  await expect(expandContextChapters(f.store, f.sessionId, [text('prefix'), missing])).rejects.toThrow('missing');
  const foreign = clone(wire.ProviderMessageSchema, original); foreign.compactedChapter!.ownerSessionId = randomUUID();
  await expect(expandContextChapters(f.store, f.sessionId, [foreign])).rejects.toThrow('sessions');
  const ctrl = new AbortController(); ctrl.abort(new Error('cancelled chapter traversal'));
  await expect(expandContextChapters(f.store, f.sessionId, [original], ctrl.signal)).rejects.toThrow('cancelled');
});

it('retains the 1024 distinct attachment bound even with iterative traversal', async () => {
  const f = fixture(); let top = await f.commit([text('original')]);
  for (let n = 1; n < 1025; n++) top = await f.commit([top]);
  await expect(expandContextChapters(f.store, f.sessionId, [top])).rejects.toThrow('projection exceeds its bounds');
});
