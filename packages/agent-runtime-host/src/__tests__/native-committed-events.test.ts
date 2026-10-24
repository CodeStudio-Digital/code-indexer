import { createHash } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { agentV1SessionStore as wire } from '@mcp/agent-runtime-contracts';
import { NativeCommittedEventStream, NativeEventReplayRequired } from '../native/NativeCommittedEventStream.js';
import { NativeContentAssembler } from '../native/NativeContentAssembler.js';
import { engineRecordStorage } from '../ipc/EngineContentRecord.js';

function event(sequence: bigint) {
  return { record: create(wire.EngineEventRecordV1Schema, { localSequence: sequence,
    body: { case: 'providerStarted', value: { operationId: 'operation' } } }),
  receipt: create(wire.CommitSessionRecordReceiptSchema, { globalSequence: sequence }) };
}

describe('bounded committed native stream', () => {
  it('delivers the first committed result while the producer is still running and preserves exact reconnect cursors', async () => {
    const stream = new NativeCommittedEventStream();
    const controller = new AbortController();
    const iterator = stream.subscribe(0n, controller.signal);
    const pending = iterator.next();
    const first = event(3n); stream.publish(first.record, first.receipt);
    expect((await pending).value?.receipt.globalSequence).toBe(3n);
    first.record.localSequence = 100n;
    const second = event(7n); stream.publish(second.record, second.receipt);
    stream.close();
    const replay = [];
    for await (const value of stream.subscribe(3n)) replay.push(value.receipt.globalSequence);
    expect(replay).toEqual([7n]);
    const independent = stream.subscribe();
    expect((await independent.next()).value?.record.localSequence).toBe(3n);
    await independent.return(undefined);
    controller.abort(); await iterator.return(undefined);
  });

  it('evicts globally and tells a slow consumer to recover without silently skipping events', async () => {
    const stream = new NativeCommittedEventStream(2);
    const iterator = stream.subscribe();
    const pending = iterator.next();
    for (let sequence = 1n; sequence <= 4n; sequence++) {
      const value = event(sequence); stream.publish(value.record, value.receipt);
    }
    await expect(pending).rejects.toBeInstanceOf(NativeEventReplayRequired);
    stream.close();
    const recovered = [];
    for await (const value of stream.subscribe(2n)) recovered.push(value.receipt.globalSequence);
    expect(recovered).toEqual([3n, 4n]);
  });

  it('bounds bytes as well as count and releases a disconnected waiting subscriber', async () => {
    const stream = new NativeCommittedEventStream(10, 256 * 1024);
    const controller = new AbortController();
    const iterator = stream.subscribe(0n, controller.signal);
    const pending = iterator.next(); controller.abort();
    expect((await pending).done).toBe(true);
    for (let sequence = 1n; sequence <= 4n; sequence++) {
      const value = event(sequence);
      value.record.body = { case: 'content', value: chunk(new Uint8Array(128 * 1024), 0, 128 * 1024) };
      stream.publish(value.record, value.receipt);
    }
    await expect(stream.subscribe(1n).next()).rejects.toBeInstanceOf(NativeEventReplayRequired);
    stream.close();
  });

  it('return wakes a pending next without requiring the publisher to emit another event', async () => {
    const stream = new NativeCommittedEventStream();
    const iterator = stream.subscribe();
    const pending = iterator.next();
    await iterator.return();
    expect((await pending).done).toBe(true);
  });
});

function chunk(bytes: Uint8Array, offset: number, length: number) {
  return create(wire.EngineContentRecordV1Schema, { kind: wire.EngineContentKindV1.TOOL_RESULT,
    operationId: 'operation', contentId: 'content', toolUseId: 'tool', contentSchemaId: 'result',
    contentSchemaVersion: 1, totalBytes: BigInt(bytes.byteLength), chunkOffset: BigInt(offset),
    encodedChunk: bytes.slice(offset, offset + length), contentSha256: createHash('sha256').update(bytes).digest() });
}

describe('durable content reassembly', () => {
  it('verifies a large multibyte result before exposing it and keeps content out of lifecycle records', () => {
    const bytes = new TextEncoder().encode('ação'.repeat(40_000));
    const assembler = new NativeContentAssembler();
    let result: Uint8Array | undefined;
    for (let offset = 0; offset < bytes.byteLength; offset += 128 * 1024) {
      const value = chunk(bytes, offset, 128 * 1024);
      result = assembler.append(value);
      expect(engineRecordStorage(create(wire.EngineEventRecordV1Schema, { body: { case: 'content', value } })).kind)
        .toBe(wire.SessionRecordKind.TOOL_OUTPUT);
      if (offset + 128 * 1024 < bytes.byteLength) expect(result).toBeUndefined();
    }
    expect(result).toEqual(bytes); assembler.assertComplete();
  });

  it('rejects corruption, missing chunks, changed metadata and an incomplete terminal', () => {
    const bytes = new Uint8Array(150_000).fill(1);
    for (const alteration of ['corruption', 'missing', 'metadata', 'incomplete']) {
      const assembler = new NativeContentAssembler();
      assembler.append(chunk(bytes, 0, 128 * 1024));
      const tail = chunk(bytes, 128 * 1024, 128 * 1024);
      if (alteration === 'corruption') tail.encodedChunk[0] = 2;
      if (alteration === 'missing') tail.chunkOffset++;
      if (alteration === 'metadata') tail.toolUseId = 'foreign';
      expect(() => alteration === 'incomplete' ? assembler.assertComplete() : assembler.append(tail)).toThrow();
    }
  });
});
