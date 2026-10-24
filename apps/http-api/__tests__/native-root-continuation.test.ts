import { createHash, randomUUID } from 'node:crypto';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { expect, it, vi } from 'vitest';
import { agentV1Artifact as artifact, agentV1Runtime as wire, agentV1SessionStore as journal } from '@mcp/agent-runtime-contracts';
import { createNativeConversationMaterial, type NativeSessionReader } from '@mcp/agent-runtime-host';
import type { AgentMessage } from '@mcp/provider-sdk/wire.js';
import type { prepareNativeCoderContext } from '@mcp/code-agent/runtime/native-coder-context.js';
import { commitContextChapters } from '../../../packages/agent-runtime-host/src/native/NativeContextChapters.js';
import { nativeConversationDigest, nativePublicConversationDigest } from '../../../packages/agent-runtime-host/src/native/NativeConversationDigest.js';
import { encodeNativeConversationMessage } from '../../../packages/agent-runtime-host/src/native/NativeConversationMessage.js';
import { encodeProviderFrontier, sha256 } from '../../../packages/agent-runtime-host/src/native/ProviderFrontierCodec.js';
import { inspectNativeContinuation } from '../workers/native-coder-continuation.js';
import { NativeRootContinuation } from '../workers/native-root-continuation.js';
import { identity as attemptIdentity } from '../../../packages/agent-runtime-host/src/__tests__/attempt-channel-support.js';

async function largeFixture() {
  const sessionId = randomUUID(), attemptId = randomUUID(), agentRunId = randomUUID();
  const authority = create(journal.SessionStoreAuthoritySchema, { storageGeneration: journal.StorageGeneration.RUST_FS_V1, leaseEpoch: 1n, writerId: attemptId });
  const messages: AgentMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'Preserve every confirmed result.' }] }];
  for (let index = 0; index < 700; index++) messages.push(
    { role: 'assistant', content: [{ type: 'tool_use', id: `tool-${index}`, name: 'read_file', input: { path: `file-${index}` } }] },
    { role: 'tool', content: [{ type: 'tool_result', tool_use_id: `tool-${index}`, content: `${index}:` + 'x'.repeat(16 * 1024) }] });
  const encoded = await Promise.all(messages.map(message => encodeNativeConversationMessage(message, async () => { throw new Error('No attachments'); })));
  const rows: Array<{ receipt: journal.CommitSessionRecordReceipt; payload: Uint8Array }> = [];
  const append = (operationId: string, kind: journal.SessionRecordKind, payload: Uint8Array) => {
    const receipt = create(journal.CommitSessionRecordReceiptSchema, { sessionId, authority, operationId, kind,
      durability: journal.SessionDurabilityClass.AUTHORITATIVE, globalSequence: BigInt(rows.length + 1),
      payloadBytes: BigInt(payload.length), payloadSha256: sha256(payload), commitSha256: new Uint8Array(32) });
    rows.push({ receipt, payload: payload.slice() }); return receipt;
  };
  const summaries: wire.ProviderMessage[] = [];
  const client = { async request(body: journal.SessionStoreRequest['body']): Promise<journal.SessionStoreResponse['body']> {
    if (body.case !== 'commitSessionRecord') throw new Error('Unexpected request');
    return { case: 'commitSessionRecordReceipt', value: append(body.value.operationId, body.value.kind, body.value.encodedPayload) };
  } };
  for (let index = 0; index < 4; index++) {
    const first = index ? index * 350 + 1 : 0, last = (index + 1) * 350 + 1;
    const bytes = toBinary(wire.ProviderContextChapterV1Schema, create(wire.ProviderContextChapterV1Schema,
      { schemaVersion: 1, sessionId, messages: encoded.slice(first, last) }));
    const reference = create(artifact.ArtifactRefSchema, { artifactId: randomUUID(), ownerSessionId: sessionId, kind: 'document',
      contentSha256: sha256(bytes), byteLength: BigInt(bytes.length), compression: artifact.ArtifactCompression.NONE,
      privacyClass: artifact.ArtifactPrivacyClass.CONFIDENTIAL, redactionPolicyVersion: 'native-context-chapter-v1',
      mediaType: 'application/vnd.codestudio.context-chapter.v1+protobuf' });
    const summary = create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.ASSISTANT, isMeta: true, compactedChapter: reference,
      content: [{ body: { case: 'text', value: { body: { case: 'inlineUtf8', value: `Chapter ${index}` } } } }] });
    summaries.push(summary);
    await commitContextChapters(client, 'writer', authority, sessionId, create(wire.ProviderStartSchema,
      { messages: [summary], pendingChapters: [{ reference, encodedChapter: bytes }] }), new AbortController().signal);
  }
  const identity = { ...attemptIdentity(), sessionId, attemptId, agentRunId };
  const frontier = encodeProviderFrontier(create(wire.ProviderStartSchema, { identity, operationId: 'provider/700',
    binding: { effectiveProvider: 'fixture', effectiveModel: 'fixture' }, messages: summaries }));
  append('frontier', journal.SessionRecordKind.CHECKPOINT, frontier.payload);
  append('terminal', journal.SessionRecordKind.LIFECYCLE_EVENT, toBinary(journal.EngineEventRecordV1Schema,
    create(journal.EngineEventRecordV1Schema, { schemaVersion: 1, identity, runtimeInstanceId: 'fixture', localSequence: 1n,
      body: { case: 'terminal', value: { classification: journal.EngineTerminalClassificationV1.INTERRUPTED } } })));
  const reader = { state: { sessionId, authority, committedRecords: BigInt(rows.length), lastCommitSha256: new Uint8Array(32) },
    assertCurrent: vi.fn(async () => undefined), store: {
      async list(after: bigint, maximum: number) {
        const records = rows.slice(Number(after), Number(after) + maximum).map(row => row.receipt);
        const next = records.at(-1)?.globalSequence ?? after;
        return { records, nextGlobalSequence: next, complete: next === BigInt(rows.length) };
      }, async read(receipt: journal.CommitSessionRecordReceipt) { return rows[Number(receipt.globalSequence) - 1]!.payload.slice(); },
    } } as unknown as NativeSessionReader;
  return { reader, sessionId, messages, encoded, summaries };
}

it('validates over 8 MiB public history and hydrates only the authenticated frontier under 512 KiB', async () => {
  const f = await largeFixture();
  expect(Buffer.byteLength(JSON.stringify(f.messages))).toBeGreaterThan(8 * 1024 * 1024);
  const proof = (await inspectNativeContinuation(f.reader, true))!;
  expect(proof.messagesSha256).toBe(nativeConversationDigest(f.encoded));
  const continuation = await NativeRootContinuation.open(f.reader, proof, { sessionId: f.sessionId, messages: f.messages });
  const material = { initialConversationSnapshot: { ref: 'marker' }, providerBinding: create(wire.ProviderBindingSchema,
    { effectiveProvider: 'fixture', effectiveModel: 'fixture' }),
    source: { items: [{ reference: { case: 'snapshot', value: { ref: 'marker' } }, byteLength: 1n }], close: vi.fn() },
  } as unknown as Awaited<ReturnType<typeof prepareNativeCoderContext>>;
  const sealed = continuation.prepare(material, randomUUID());
  expect(sealed.reference.byteLength).toBeLessThan(512n * 1024n);
  const bytes = await sealed.source.readExact(0, 0n, Number(sealed.reference.byteLength));
  const resumed = fromBinary(wire.ProviderResumeContextV1Schema, bytes);
  expect(resumed.context!.messages).toEqual(f.summaries);
  expect(resumed.context!.previousResponseId).toBeUndefined();
  await sealed.source.close(); continuation.close();
  f.messages[3] = { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'tampered' } }] };
  await expect(NativeRootContinuation.open(f.reader, proof, { sessionId: f.sessionId, messages: f.messages })).rejects.toThrow('history differs');
  await expect(NativeRootContinuation.open(f.reader, { ...proof, sourceAttemptId: randomUUID() },
    { sessionId: f.sessionId, messages: f.messages })).rejects.toThrow('authority');
});

it('preserves canonical protobuf bytes and attachments while accepting only paired display-ID renames', async () => {
  const sessionId = randomUUID(), messages: AgentMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'Task' }, { type: 'image', mediaType: 'image/png', base64: Buffer.from('image').toString('base64') }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'display-1', name: 'read_file', input: { path: 'original' } }] },
    { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'display-1', content: 'result', is_error: false }] },
    { role: 'user', content: [{ type: 'text', text: 'Continue' }] },
  ];
  const material = await createNativeConversationMaterial({ sessionId, messages, maximumBytes: 1024 * 1024 });
  try {
    const bytes = await material.source.readExact(0, 0n, Number(material.source.items[0]!.byteLength));
    const initial = fromBinary(wire.InitialConversationSnapshotV1Schema, bytes);
    for (const message of initial.messages) for (const block of message.content) {
      if (block.body.case === 'toolUse' || block.body.case === 'toolResult') block.body.value.toolUseId = 'call:1';
    }
    const exact = createHash('sha256').update(toBinary(wire.ProviderTurnContextSchema,
      create(wire.ProviderTurnContextSchema, { messages: initial.messages }))).digest('hex');
    expect(await nativePublicConversationDigest({ sessionId, messages })).toBe(exact);
    expect(nativeConversationDigest(initial.messages)).toBe(exact);
    (messages[2]!.content[0] as { tool_use_id: string }).tool_use_id = 'wrong';
    await expect(nativePublicConversationDigest({ sessionId, messages })).rejects.toThrow('unmatched');
  } finally { material.close(); }
});
