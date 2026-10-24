import { randomUUID } from 'node:crypto';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { afterEach, expect, it, vi } from 'vitest';
import { agentV1Artifact as artifact, agentV1Runtime as wire, agentV1SessionStore as journal } from '@mcp/agent-runtime-contracts';
import { NativeSessionReader, type VerifiedRuntimePackage } from '@mcp/agent-runtime-host';
import type { ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import type { prepareNativeCoderContext } from '@mcp/code-agent/runtime/native-coder-context.js';
import { identity } from '../../../packages/agent-runtime-host/src/__tests__/attempt-channel-support.js';
import { encodeProviderFrontier, sha256 } from '../../../packages/agent-runtime-host/src/native/ProviderFrontierCodec.js';
import { attachmentOperationId } from '../../../packages/agent-runtime-host/src/native/NativeSessionAttachments.js';
import { NativeChildContinuation } from '../workers/native-child-continuation.js';

vi.mock('../native-child-storage.js', () => ({ resolveNativeChildSessionRoot: vi.fn(async () => 'validated-child-root') }));
afterEach(() => vi.restoreAllMocks());

function fixture(fault?: 'unknown' | 'completed' | 'missing' | 'corrupt') {
  const I = identity(), content = Buffer.from('confirmed image bytes');
  const reference = create(artifact.ArtifactRefSchema, { artifactId: randomUUID(), kind: 'image', ownerSessionId: I.sessionId,
    mediaType: 'image/png', byteLength: BigInt(content.length), contentSha256: sha256(content), compression: artifact.ArtifactCompression.NONE,
    privacyClass: artifact.ArtifactPrivacyClass.CONFIDENTIAL, redactionPolicyVersion: 'initial-conversation-v1' });
  const binding = { effectiveProvider: 'selected-account', effectiveModel: 'selected-model' };
  const messages = [create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.USER, content: [
    { body: { case: 'text', value: { body: { case: 'inlineUtf8', value: 'original task' } } } }, { body: { case: 'attachment', value: reference } },
  ] })];
  const frontier = encodeProviderFrontier(create(wire.ProviderStartSchema, { identity: I, operationId: 'provider/1', messages, binding }));
  const rows: { operationId: string; kind: journal.SessionRecordKind; payload: Uint8Array }[] = [
    { operationId: 'unreferenced-large-artifact', kind: journal.SessionRecordKind.ATTACHMENT, payload: Buffer.from('must not be loaded') },
    { operationId: attachmentOperationId(reference.artifactId, 0), kind: journal.SessionRecordKind.ATTACHMENT,
      payload: toBinary(journal.SessionAttachmentChunkV1Schema, create(journal.SessionAttachmentChunkV1Schema, {
        schemaVersion: 1, reference, encodedChunk: fault === 'corrupt' ? Buffer.from('corrupt') : content,
      })) },
    { operationId: 'frontier', kind: journal.SessionRecordKind.CHECKPOINT, payload: frontier.payload },
  ];
  if (fault === 'missing') rows.splice(1, 1);
  const event = (body: NonNullable<Parameters<typeof create<typeof journal.EngineEventRecordV1Schema>>[1]>['body']) => {
    rows.push({ operationId: randomUUID(), kind: journal.SessionRecordKind.LIFECYCLE_EVENT,
      payload: toBinary(journal.EngineEventRecordV1Schema, create(journal.EngineEventRecordV1Schema, {
        schemaVersion: 1, identity: I, runtimeInstanceId: 'fixture-runtime', localSequence: BigInt(rows.length), body,
      })) });
  };
  if (fault === 'unknown') event({ case: 'capabilityDispatchStarted', value: { operationId: 'write', toolUseId: 'write', grantId: 'grant',
    effectiveInputSha256: new Uint8Array(32), startedAtUnixMs: 1n } });
  event({ case: 'terminal', value: { classification: fault === 'completed'
    ? journal.EngineTerminalClassificationV1.COMPLETED : journal.EngineTerminalClassificationV1.INTERRUPTED } });
  const receipts = rows.map((row, index) => create(journal.CommitSessionRecordReceiptSchema, { sessionId: I.sessionId,
    operationId: row.operationId, globalSequence: BigInt(index + 1), kind: row.kind, durability: journal.SessionDurabilityClass.AUTHORITATIVE,
    payloadBytes: BigInt(row.payload.length), payloadSha256: sha256(row.payload), commitSha256: new Uint8Array(32) }));
  const read = vi.fn(async (receipt: journal.CommitSessionRecordReceipt) => rows[Number(receipt.globalSequence) - 1]!.payload);
  const close = vi.fn(async () => undefined), assertOwner = vi.fn(async () => undefined);
  const reader = { close, assertCurrent: vi.fn(async () => undefined), state: { sessionId: I.sessionId,
    authority: { writerId: I.attemptId }, committedRecords: BigInt(rows.length), lastCommitSha256: new Uint8Array(32) },
    store: { read, async list(after: bigint, maximum: number) {
      const records = receipts.slice(Number(after), Number(after) + maximum), next = records.at(-1)?.globalSequence ?? after;
      return { records, nextGlobalSequence: next, complete: next === BigInt(rows.length) };
    } },
  } as unknown as NativeSessionReader;
  vi.spyOn(NativeSessionReader, 'open').mockResolvedValue(reader);
  const input = { context: { sessionId: I.sessionId, agentRunId: I.agentRunId, attemptId: I.attemptId } as ControlPlaneRunContext,
    rootPath: 'root', runtimePackage: {} as VerifiedRuntimePackage, provider: binding.effectiveProvider, model: binding.effectiveModel,
    signal: new AbortController().signal, assertOwner };
  return { input, reference, content, read, close, assertOwner, binding };
}

it('loads only referenced attachments and seals the new guidance without mutating the durable source', async () => {
  const f = fixture(), source = await NativeChildContinuation.open(f.input);
  expect(f.close).toHaveBeenCalledOnce(); expect(f.assertOwner).toHaveBeenCalledTimes(2);
  expect(f.read.mock.calls.some(([receipt]) => receipt.operationId === 'unreferenced-large-artifact')).toBe(false);
  expect(Buffer.from(source.artifactReader.read(f.reference, 1024, f.input.signal))).toEqual(f.content);
  const material = { initialConversationSnapshot: { ref: 'seed' }, providerBinding: create(wire.ProviderBindingSchema, f.binding),
    source: { items: [{ reference: { case: 'snapshot', value: { ref: 'seed' } }, byteLength: 1n }], close: vi.fn(async () => undefined) },
  } as unknown as Awaited<ReturnType<typeof prepareNativeCoderContext>>;
  const newId = randomUUID(), sealed = source.prepare(material, newId, 'Continue without rewriting.');
  const bytes = await sealed.source.readExact(0, 0n, Number(sealed.reference.byteLength));
  const resumed = fromBinary(wire.ProviderResumeContextV1Schema, bytes);
  expect(resumed.agentRunId).toBe(newId); expect(resumed.sourceAttemptId).toBe(f.input.context.attemptId);
  expect(resumed.context!.messages).toHaveLength(2);
  expect(resumed.context!.messages[1]!.content[0]!.body).toMatchObject({ case: 'text', value: { body: { value: 'Continue without rewriting.' } } });
  expect(sealed.proof.guidanceSha256).toBe(Buffer.from(sha256(Buffer.from('Continue without rewriting.'))).toString('hex'));
  await sealed.source.close(); source.close();
  expect(() => source.artifactReader.read(f.reference, 1024, f.input.signal)).toThrow('missing');
});

it.each(['unknown', 'completed', 'missing', 'corrupt'] as const)('refuses unsafe or incomplete native child continuation: %s', async fault => {
  const f = fixture(fault);
  await expect(NativeChildContinuation.open(f.input)).rejects.toThrow(); expect(f.close).toHaveBeenCalledOnce();
});

it('rejects provider changes and lost authority before exposing any resume material', async () => {
  const f = fixture();
  await expect(NativeChildContinuation.open({ ...f.input, model: 'other-model' })).rejects.toThrow('configured provider');
  f.assertOwner.mockRejectedValueOnce(new Error('fenced'));
  await expect(NativeChildContinuation.open(f.input)).rejects.toThrow('fenced');
});
