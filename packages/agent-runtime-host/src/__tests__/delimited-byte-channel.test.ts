import { PassThrough, Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  DelimitedByteChannel,
  DelimitedChannelError,
} from '../ipc/DelimitedByteChannel.js';

function receiver(chunks: readonly Uint8Array[], maximumFrameBytes = 64) {
  return new DelimitedByteChannel(
    Readable.from(chunks),
    new PassThrough(),
    { maximumFrameBytes },
  );
}

function observeAllocation(length: number) {
  const Original = globalThis.Uint8Array;
  let allocation: Uint8Array | undefined;
  const Observed = new Proxy(Original, {
    construct(target, argumentsList) {
      const value = Reflect.construct(
        target,
        argumentsList,
        target,
      ) as Uint8Array;
      if (argumentsList[0] === length) allocation = value;
      return value;
    },
  });
  vi.stubGlobal('Uint8Array', Observed);
  return {
    value: () => allocation,
    restore: () => vi.unstubAllGlobals(),
  };
}

describe('DelimitedByteChannel', () => {
  it('round-trips frames split across arbitrary transport chunks', async () => {
    const transport = new PassThrough();
    const channel = new DelimitedByteChannel(
      transport,
      transport,
      { maximumFrameBytes: 64 },
    );

    await channel.send(Uint8Array.from([1, 2, 3, 4]));
    await expect(channel.receive()).resolves.toEqual(Uint8Array.from([1, 2, 3, 4]));
  });

  it('scrubs consumed source bytes while preserving unread frames', async () => {
    const source = Uint8Array.from([2, 7, 8, 1, 9]);
    const channel = receiver([source]);

    await expect(channel.receive()).resolves.toEqual(Uint8Array.of(7, 8));
    expect(source).toEqual(Uint8Array.from([0, 0, 0, 1, 9]));
    await expect(channel.receive()).resolves.toEqual(Uint8Array.of(9));
    expect(source).toEqual(new Uint8Array(5));
  });

  it('scrubs unread remainder and rejected oversized chunks on failure', async () => {
    const remainder = Uint8Array.from([1, 7, 1, 8]);
    const channel = receiver([remainder]);
    await channel.receive();
    channel.fail(new Error('stop'));
    expect(remainder).toEqual(new Uint8Array(4));

    const oversized = Uint8Array.from([1, 2, 3, 4]);
    const bounded = new DelimitedByteChannel(
      Readable.from([oversized]),
      new PassThrough(),
      { maximumFrameBytes: 8, maximumTransportChunkBytes: 3 },
    );
    await expect(bounded.receive()).rejects.toMatchObject({
      code: 'transport_chunk_too_large',
    });
    expect(oversized).toEqual(new Uint8Array(4));
  });

  it('scrubs a partially assembled body after truncated EOF', async () => {
    const source = Uint8Array.from([5, 7, 8]);
    const observed = observeAllocation(5);
    try {
      const channel = receiver([source]);
      await expect(channel.receive()).rejects.toMatchObject({
        code: 'truncated_frame',
      });
      expect(observed.value()).toBeDefined();
      expect(observed.value()!.every((value) => value === 0)).toBe(true);
    } finally {
      observed.restore();
    }
  });

  it('scrubs a partially assembled body when its read times out', async () => {
    vi.useFakeTimers();
    const source = new PassThrough();
    const partial = Uint8Array.from([5, 7, 8]);
    const channel = new DelimitedByteChannel(source, new PassThrough(), {
      maximumFrameBytes: 64,
      readTimeoutMs: 5,
    });
    const observed = observeAllocation(5);
    try {
      const receive = expect(channel.receive()).rejects.toMatchObject({
        code: 'read_timeout',
      });
      source.write(partial);
      await vi.advanceTimersByTimeAsync(5);
      await receive;
      await vi.runAllTicks();
      expect(observed.value()).toBeDefined();
      expect(observed.value()!.every((value) => value === 0)).toBe(true);
    } finally {
      observed.restore();
      vi.useRealTimers();
    }
  });

  it('permits permanent idle but times out partial frame progress', async () => {
    vi.useFakeTimers();
    const idleSource = new PassThrough();
    const idle = new DelimitedByteChannel(idleSource, new PassThrough(), {
      maximumFrameBytes: 64,
      readTimeoutMs: 5,
    });
    try {
      const receive = idle.receiveAfterIdle();
      await vi.advanceTimersByTimeAsync(50);
      idleSource.write(Uint8Array.of(1, 7));
      await expect(receive).resolves.toEqual(Uint8Array.of(7));

      const partialSource = new PassThrough();
      const partial = new DelimitedByteChannel(partialSource, new PassThrough(), {
        maximumFrameBytes: 64,
        readTimeoutMs: 5,
      });
      const timed = expect(partial.receiveAfterIdle()).rejects.toMatchObject({
        code: 'read_timeout',
      });
      partialSource.write(Uint8Array.of(2, 9));
      await vi.advanceTimersByTimeAsync(5);
      await timed;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects oversized length before waiting for its body', async () => {
    const channel = receiver([Uint8Array.from([0x81, 0x08])], 1_024);

    await expect(channel.receive()).rejects.toMatchObject({
      code: 'frame_too_large',
    });
    await expect(channel.receive()).rejects.toMatchObject({
      code: 'channel_failed',
    });
  });

  it.each([
    [[0], 'empty_frame'],
    [[0x80], 'truncated_length'],
    [[0x81, 0], 'non_canonical_length'],
    [[0xff, 0xff, 0xff, 0xff, 0xff], 'length_overflow'],
    [[5, 1], 'truncated_frame'],
  ] as const)('rejects malformed framing %#', async (bytes, code) => {
    const channel = receiver([Uint8Array.from(bytes)]);

    await expect(channel.receive()).rejects.toMatchObject({ code });
  });

  it('enforces a bounded transport chunk independently of frame length', async () => {
    const channel = new DelimitedByteChannel(
      Readable.from([Uint8Array.from([1, 7, 1, 8])]),
      new PassThrough(),
      { maximumFrameBytes: 2, maximumTransportChunkBytes: 3 },
    );

    await expect(channel.receive()).rejects.toMatchObject({
      code: 'transport_chunk_too_large',
    });
  });

  it('writes without copying the full frame into one transport packet', async () => {
    const chunkLengths: number[] = [];
    const writable = new Writable({
      write: (chunk, _encoding, callback) => {
        chunkLengths.push(chunk.byteLength);
        callback();
      },
    });
    const channel = new DelimitedByteChannel(
      Readable.from([]),
      writable,
      { maximumFrameBytes: 64, maximumTransportChunkBytes: 2 },
    );

    await channel.send(Uint8Array.from([1, 2, 3, 4, 5]));

    expect(chunkLengths).toEqual([1, 2, 2, 1]);
  });

  it('does not create an unbounded concurrent write queue', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writable = new Writable({
      write: (_chunk, _encoding, callback) => {
        void blocked.then(() => callback());
      },
    });
    const channel = new DelimitedByteChannel(
      Readable.from([]),
      writable,
      { maximumFrameBytes: 64 },
    );
    const first = channel.send(Uint8Array.from([1]));

    await expect(channel.send(Uint8Array.from([2]))).rejects.toEqual(
      expect.objectContaining<Partial<DelimitedChannelError>>({
        code: 'concurrent_write',
      }),
    );
    await expect(first).rejects.toMatchObject({
      code: 'concurrent_write',
    });
    release();
  });

  it('cannot reuse a transport after a partial write fails', async () => {
    const writable = new Writable({
      write: (_chunk, _encoding, callback) => {
        callback(new Error('transport closed'));
      },
    });
    writable.on('error', () => undefined);
    const channel = new DelimitedByteChannel(
      Readable.from([]),
      writable,
      { maximumFrameBytes: 64 },
    );

    await expect(channel.send(Uint8Array.of(1))).rejects.toMatchObject({
      code: 'transport_error',
    });
    await expect(channel.send(Uint8Array.of(2))).rejects.toMatchObject({
      code: 'channel_failed',
    });
  });

  it('destroys both physical endpoints exactly once when poisoned', () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const destroyReadable = vi.spyOn(readable, 'destroy');
    const destroyWritable = vi.spyOn(writable, 'destroy');
    const channel = new DelimitedByteChannel(readable, writable, {
      maximumFrameBytes: 64,
    });

    channel.fail(new Error('poison'));
    channel.fail(new Error('ignored'));

    expect(destroyReadable).toHaveBeenCalledOnce();
    expect(destroyWritable).toHaveBeenCalledOnce();
  });

  it('poisons physical endpoints on local use after ownership claim', async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const destroyReadable = vi.spyOn(readable, 'destroy');
    const destroyWritable = vi.spyOn(writable, 'destroy');
    const channel = new DelimitedByteChannel(readable, writable, {
      maximumFrameBytes: 64,
    });
    channel.claim({});

    await expect(channel.send(Uint8Array.of(1))).rejects.toMatchObject({
      code: 'channel_owned',
    });
    expect(destroyReadable).toHaveBeenCalledOnce();
    expect(destroyWritable).toHaveBeenCalledOnce();
  });

  it('never exposes retained frame bytes to a hostile Writable', async () => {
    const frame = Uint8Array.from([1, 2, 3, 4]);
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        chunk.fill(0xff);
        callback();
      },
    });
    const channel = new DelimitedByteChannel(
      Readable.from([]),
      writable,
      { maximumFrameBytes: 64, maximumTransportChunkBytes: 2 },
    );

    await channel.send(frame);

    expect(frame).toEqual(Uint8Array.from([1, 2, 3, 4]));
  });

  it('bounds an incomplete read and the complete multi-chunk write', async () => {
    vi.useFakeTimers();
    try {
      const unread = new PassThrough();
      const readChannel = new DelimitedByteChannel(
        unread,
        new PassThrough(),
        { maximumFrameBytes: 64, readTimeoutMs: 5 },
      );
      const readAssertion = expect(readChannel.receive()).rejects.toMatchObject({
        code: 'read_timeout',
      });
      await vi.advanceTimersByTimeAsync(5);
      await readAssertion;

      const slow = new Writable({
        write(_chunk, _encoding, callback) {
          setTimeout(callback, 10);
        },
      });
      const writeChannel = new DelimitedByteChannel(
        Readable.from([]),
        slow,
        {
          maximumFrameBytes: 64,
          maximumTransportChunkBytes: 1,
          writeTimeoutMs: 25,
        },
      );
      const writeAssertion = expect(
        writeChannel.send(Uint8Array.of(1, 2, 3)),
      ).rejects.toMatchObject({ code: 'write_timeout' });
      await vi.advanceTimersByTimeAsync(25);
      await writeAssertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
