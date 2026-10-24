import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { agentV1Artifact as artifact, agentV1SessionStore as wire } from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import { commitNativeSessionAttachment, NativeSessionAttachments } from '../native/NativeSessionAttachments.js';

function fixture() {
  const sessionId = randomUUID();
  const bytes = randomBytes(300_000);
  const reference = create(artifact.ArtifactRefSchema, { artifactId: randomUUID(), ownerSessionId: sessionId,
    kind: 'image', mediaType: 'image/png', contentSha256: createHash('sha256').update(bytes).digest(),
    byteLength: BigInt(bytes.length), compression: artifact.ArtifactCompression.NONE,
    privacyClass: artifact.ArtifactPrivacyClass.CONFIDENTIAL, redactionPolicyVersion: 'product-attachment-v1' });
  const authority = create(wire.SessionStoreAuthoritySchema, { storageGeneration: wire.StorageGeneration.RUST_FS_V1,
    leaseEpoch: 1n, writerId: randomUUID() });
  const records: Array<{ receipt: wire.CommitSessionRecordReceipt; payload: Uint8Array }> = [];
  const request = vi.fn(async (body: wire.SessionStoreRequest['body']): Promise<wire.SessionStoreResponse['body']> => {
    if (body.case !== 'commitSessionRecord') throw new Error('unexpected request');
    const receipt = create(wire.CommitSessionRecordReceiptSchema, { sessionId, authority,
      operationId: body.value.operationId, globalSequence: BigInt(records.length + 1), kind: body.value.kind,
      durability: body.value.durability, payloadBytes: BigInt(body.value.encodedPayload.length), payloadSha256: body.value.expectedPayloadSha256 });
    records.push({ receipt, payload: body.value.encodedPayload.slice() });
    return { case: 'commitSessionRecordReceipt', value: receipt };
  });
  const source = { read: () => bytes.slice() };
  const commit = (signal = new AbortController().signal) => commitNativeSessionAttachment({ request }, 'writer', authority, sessionId, reference, source, signal);
  return { sessionId, bytes, reference, authority, records, source, request, commit };
}

describe('native journal attachments', () => {
  it('accepts exact durable replay from an earlier writer but refuses future or same-epoch foreign ownership', async () => {
    const f = fixture(); await f.commit();
    const originalRecords = [...f.records];
    f.request.mockImplementation(async body => {
      if (body.case !== 'commitSessionRecord') throw new Error('unexpected request');
      const record = originalRecords.find(record => record.receipt.operationId === body.value.operationId)!;
      expect(body.value.encodedPayload).toEqual(record.payload);
      return { case: 'commitSessionRecordReceipt', value: record.receipt };
    });
    const current = create(wire.SessionStoreAuthoritySchema, { ...f.authority, writerId: randomUUID(), leaseEpoch: 2n });
    const commit = () => commitNativeSessionAttachment({ request: f.request }, 'next-writer', current, f.sessionId,
      f.reference, f.source, new AbortController().signal);
    await commit();
    expect(f.records).toHaveLength(3);
    current.leaseEpoch = 1n;
    await expect(commit()).rejects.toThrow('receipt diverged');
    current.leaseEpoch = 0n;
    await expect(commit()).rejects.toThrow('receipt diverged');
  });
  it('commits bounded chunks and exposes only a complete digest-verified exact reference', async () => {
    const f = fixture(); await f.commit();
    expect(f.records).toHaveLength(3);
    const projection = new NativeSessionAttachments(f.sessionId);
    const signal = new AbortController().signal;
    projection.append(f.records[0]!.receipt, f.records[0]!.payload);
    expect(() => projection.read(f.reference, 400_000, signal)).toThrow('incomplete');
    for (const record of f.records.slice(1)) projection.append(record.receipt, record.payload);
    expect(Buffer.from(projection.read(f.reference, 400_000, signal))).toEqual(f.bytes);
    expect(() => projection.read({ ...f.reference, mediaType: 'image/jpeg' }, 400_000, signal)).toThrow('authority');
    expect(() => projection.read({ ...f.reference, ownerSessionId: randomUUID() }, 400_000, signal)).toThrow('sessions');
    expect(() => projection.read(f.reference, 1, signal)).toThrow();
    projection.close();
    expect(() => projection.read(f.reference, 400_000, signal)).toThrow('missing');
  });

  it('rejects corrupted, reordered and repeated chunks', async () => {
    const f = fixture(); await f.commit();
    for (const scenario of ['corrupt', 'gap', 'duplicate']) {
      const projection = new NativeSessionAttachments(f.sessionId);
      try {
        if (scenario === 'gap') expect(() => projection.append(f.records[1]!.receipt, f.records[1]!.payload)).toThrow();
        else if (scenario === 'corrupt') {
          const corrupt = f.records[0]!.payload.slice(); corrupt[corrupt.length - 1] ^= 1;
          expect(() => projection.append(f.records[0]!.receipt, corrupt)).toThrow('receipt');
        } else {
          projection.append(f.records[0]!.receipt, f.records[0]!.payload);
          expect(() => projection.append(f.records[0]!.receipt, f.records[0]!.payload)).toThrow('diverged');
        }
      } finally { projection.close(); }
    }
  });

  it('validates bytes before the first commit and stops between chunks on cancellation', async () => {
    const invalid = fixture(); invalid.bytes[0] ^= 1;
    await expect(invalid.commit()).rejects.toThrow('digest'); expect(invalid.request).not.toHaveBeenCalled();
    const f = fixture(); const controller = new AbortController();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async body => { const result = await original(body); controller.abort(); return result; });
    await expect(f.commit(controller.signal)).rejects.toThrow();
    expect(f.records).toHaveLength(1);
    const projection = new NativeSessionAttachments(f.sessionId);
    projection.append(f.records[0]!.receipt, f.records[0]!.payload);
    expect(() => projection.read(f.reference, 400_000, new AbortController().signal)).toThrow('incomplete');
    projection.close();
  });
});
