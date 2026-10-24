import { createHash, randomUUID } from 'node:crypto';
import { create, fromBinary } from '@bufbuild/protobuf';
import { agentV1SessionStore as wire } from '@mcp/agent-runtime-contracts';
import { expect, it, vi } from 'vitest';
import { NativeToolOutputStore } from '../native/NativeToolOutputStore.js';
import { commitNativeSessionAttachment, NativeSessionAttachments } from '../native/NativeSessionAttachments.js';

function fixture() {
  const sessionId = randomUUID(), signal = new AbortController().signal;
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
  const list = vi.fn(async (after: bigint, maximum: number) => {
    const page = records.filter(row => row.receipt.globalSequence > after).slice(0, maximum);
    return { records: page.map(row => row.receipt), nextGlobalSequence: page.at(-1)?.receipt.globalSequence ?? after,
      complete: !page.length || page.at(-1) === records.at(-1) };
  });
  const close = vi.fn(async () => {});
  const options = { sessionId, signal, assertOwner() {},
    commit: (reference: Parameters<typeof commitNativeSessionAttachment>[4], reader: Parameters<typeof commitNativeSessionAttachment>[5], signal: AbortSignal) =>
      commitNativeSessionAttachment({ request }, 'writer', authority, sessionId, reference, reader, signal),
    openReader: async () => ({ close, store: { list, read: async (receipt: wire.CommitSessionRecordReceipt) =>
      records.find(row => row.receipt.operationId === receipt.operationId)!.payload.slice() } }),
  };
  return { options, records, request, list, close };
}

it('deduplicates hot spills, commits bounded chunks and recovers without the legacy filesystem store', async () => {
  const f = fixture(), content = 'row 😀\n'.repeat(40000), first = new NativeToolOutputStore(f.options);
  const id = first.put(content)!; expect(first.put(content)).toBe(id);
  await first.drain(); expect(f.records.length).toBeGreaterThan(1);
  expect(f.records.every(row => row.payload.length < 132 * 1024)).toBe(true);
  expect(await first.get(id)).toBe(content); expect(f.list).not.toHaveBeenCalled(); await first.close();
  const reopened = new NativeToolOutputStore(f.options);
  try {
    expect(await reopened.get(id)).toBe(content);
    expect(await reopened.get('a'.repeat(64))).toBe(null);
    expect(await reopened.get(id)).toBe(content);
    expect(f.list).toHaveBeenCalledTimes(1); // One validated snapshot index for all lookups.
  } finally { await reopened.close(); }
  expect(f.close).toHaveBeenCalledTimes(1);
});
it('never returns cached bytes as durable after a failed commit', async () => {
  const f = fixture(); f.request.mockRejectedValue(new Error('disk full'));
  const store = new NativeToolOutputStore(f.options), id = store.put('uncommitted')!;
  await expect(store.drain()).rejects.toThrow('disk full');
  await expect(store.get(id)).rejects.toThrow('disk full');
  expect(() => store.put('later')).toThrow('disk full'); await store.close();
});
it.each(['corrupt', 'partial', 'foreign'])('refuses %s recovery evidence', async mode => {
  const f = fixture(), first = new NativeToolOutputStore(f.options);
  const id = first.put('x'.repeat(200000))!; await first.drain(); await first.close();
  if (mode === 'corrupt') f.records[0]!.payload[20] ^= 1;
  if (mode === 'partial') f.records.pop();
  if (mode === 'foreign') f.records[0]!.receipt.sessionId = randomUUID();
  const reopened = new NativeToolOutputStore(f.options);
  try { await expect(reopened.get(id)).rejects.toThrow(); } finally { await reopened.close(); }
});
it('keeps spills outside the media projection and honors cache and lifetime bounds', async () => {
  const f = fixture(), controller = new AbortController();
  const store = new NativeToolOutputStore({ ...f.options, maximumBytes: 20, signal: controller.signal });
  const id = store.put('small output')!; expect(store.put('too long to fit now')).toBe(null);
  await store.drain();
  const media = new NativeSessionAttachments(f.options.sessionId);
  const record = f.records[0]!, reference = fromBinary(wire.SessionAttachmentChunkV1Schema, record.payload).reference!;
  expect(Buffer.from(reference.contentSha256).toString('hex')).toBe(createHash('sha256').update('small output').digest('hex'));
  media.append(record.receipt, record.payload);
  expect(() => media.read(reference, 20, f.options.signal)).toThrow('missing'); media.close();
  controller.abort(new Error('attempt revoked'));
  await expect(store.get(id)).rejects.toThrow('attempt revoked'); await store.close();
});
