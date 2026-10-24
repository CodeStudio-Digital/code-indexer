import { createHash } from 'node:crypto';
import { create, toBinary } from '@bufbuild/protobuf';
import { agentV1Common, agentV1Runtime as wire } from '@mcp/agent-runtime-contracts';
import { describe, expect, it } from 'vitest';
import { ProviderRequestTransfer } from '../ipc/ProviderRequestTransfer.js';
import { identity } from './attempt-channel-support.js';

function fixture() {
  const context = { identity: identity(), runtimeInstanceId: 'runtime/1', timeoutMs: 5000,
    limits: create(agentV1Common.FrameLimitsSchema) };
  const start = create(wire.ProviderStartSchema, { identity: context.identity, operationId: 'op/1',
    deadlineAtUnixMs: 5000n, system: create(wire.ProviderTextContentSchema, { body: { case: 'inlineUtf8', value: 'x'.repeat(1200 * 1024) } }) });
  const bytes = toBinary(wire.ProviderStartSchema, start);
  const coordinates = { identity: context.identity, runtimeInstanceId: context.runtimeInstanceId,
    operationId: start.operationId, totalBytes: BigInt(bytes.length), checkpointOnly: false,
    requestSha256: createHash('sha256').update(bytes).digest() };
  const transfer = new ProviderRequestTransfer(context);
  const chunk = (offset = 0) => create(wire.ProviderRequestChunkSchema, { ...coordinates,
    chunkOffset: BigInt(offset), encodedChunk: bytes.slice(offset, offset + 128 * 1024) });
  const commit = () => create(wire.ProviderRequestCommitSchema, coordinates);
  const appendAll = () => { for (let offset = 0; offset < bytes.length; offset += 128 * 1024) transfer.append(chunk(offset), 5000n); };
  return { transfer, chunk, commit, appendAll, bytes, start };
}

describe('bounded provider request transfer', () => {
  it('reassembles more than a Data frame and preserves content after releasing ownership', () => {
    const f = fixture(); f.appendAll();
    expect(f.transfer.pending).toBe(true);
    const start = f.transfer.finish(f.commit(), 5000n);
    expect(f.transfer.pending).toBe(false);
    expect(toBinary(wire.ProviderStartSchema, start)).toEqual(f.bytes);
    f.appendAll(); expect(f.transfer.finish(f.commit(), 5000n)).toEqual(start);
  });
  it.each([
    ['runtime', (v: wire.ProviderRequestChunk) => { v.runtimeInstanceId = 'foreign'; }],
    ['owner', (v: wire.ProviderRequestChunk) => { v.identity = create(agentV1Common.AttemptIdentitySchema, { ...v.identity!, executorOwnerId: 'foreign' }); }],
    ['oversized allocation', (v: wire.ProviderRequestChunk) => { v.totalBytes = 16n * 1024n * 1024n + 1n; }],
    ['empty transfer', (v: wire.ProviderRequestChunk) => { v.totalBytes = 0n; }],
    ['oversized chunk', (v: wire.ProviderRequestChunk) => { v.encodedChunk = new Uint8Array(128 * 1024 + 1); }],
    ['empty chunk', (v: wire.ProviderRequestChunk) => { v.encodedChunk = new Uint8Array(); }],
    ['offset', (v: wire.ProviderRequestChunk) => { v.chunkOffset = 1n; }],
    ['digest length', (v: wire.ProviderRequestChunk) => { v.requestSha256 = new Uint8Array(31); }],
  ] as const)('rejects invalid %s before allocating a transfer', (_label, mutate) => {
    const f = fixture(); const chunk = f.chunk(); mutate(chunk);
    expect(() => f.transfer.append(chunk, 5000n)).toThrow(); expect(f.transfer.pending).toBe(false);
  });
  it.each(['operationId', 'checkpointOnly', 'totalBytes', 'requestSha256', 'deadline'] as const)(
    'rejects changed %s in subsequent chunks', field => {
      const f = fixture(); f.transfer.append(f.chunk(), 5000n); const chunk = f.chunk(128 * 1024);
      if (field === 'operationId') chunk.operationId = 'op/2';
      if (field === 'checkpointOnly') chunk.checkpointOnly = true;
      if (field === 'totalBytes') chunk.totalBytes++;
      if (field === 'requestSha256') chunk.requestSha256[0] ^= 1;
      expect(() => f.transfer.append(chunk, field === 'deadline' ? 5001n : 5000n)).toThrow();
      f.transfer.clear(); expect(f.transfer.pending).toBe(false);
    });
  it('rejects duplicate chunks, incomplete commits and stale commits after cancellation', () => {
    const f = fixture(); f.transfer.append(f.chunk(), 5000n);
    expect(() => f.transfer.append(f.chunk(), 5000n)).toThrow(/contiguous/);
    expect(() => f.transfer.finish(f.commit(), 5000n)).toThrow(/incomplete/);
    expect(f.transfer.pending).toBe(false); f.appendAll(); f.transfer.clear();
    expect(() => f.transfer.finish(f.commit(), 5000n)).toThrow();
  });
  it('rejects corruption even when each outer frame was authenticated', () => {
    const f = fixture(); const first = f.chunk(); first.encodedChunk[100] ^= 1;
    f.transfer.append(first, 5000n);
    for (let offset = 128 * 1024; offset < f.bytes.length; offset += 128 * 1024) f.transfer.append(f.chunk(offset), 5000n);
    expect(() => f.transfer.finish(f.commit(), 5000n)).toThrow(/corrupt/); expect(f.transfer.pending).toBe(false);
  });
});
