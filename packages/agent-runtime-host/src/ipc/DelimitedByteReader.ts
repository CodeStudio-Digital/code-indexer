import type { Readable } from 'node:stream';
import { DelimitedChannelError } from './DelimitedChannelError.js';
import { withTransportTimeout } from './DelimitedChannelTiming.js';

const MAX_U32_VARINT_BYTES = 5;

export class DelimitedByteReader {
  readonly #iterator: AsyncIterator<unknown>;
  #chunk: Uint8Array<ArrayBufferLike> = new Uint8Array();
  #chunkOffset = 0;

  constructor(
    readable: Readable,
    private readonly maximumTransportChunkBytes: number,
  ) {
    this.#iterator = readable[Symbol.asyncIterator]();
  }

  async receive(maximumFrameBytes: number): Promise<Uint8Array | undefined> {
    return this.#receive(maximumFrameBytes);
  }

  /** Waits indefinitely for the first byte, then bounds frame progress. */
  async receiveAfterIdle(
    maximumFrameBytes: number,
    progressTimeoutMs: number,
  ): Promise<Uint8Array | undefined> {
    return this.#receive(maximumFrameBytes, progressTimeoutMs);
  }

  async #receive(
    maximumFrameBytes: number,
    progressTimeoutMs?: number,
  ): Promise<Uint8Array | undefined> {
    const length = await this.#readLength(progressTimeoutMs);
    if (length === undefined) return undefined;
    if (length === 0) {
      throw new DelimitedChannelError('empty_frame', 'zero-length frame is forbidden');
    }
    if (length > maximumFrameBytes) {
      throw new DelimitedChannelError(
        'frame_too_large',
        `frame length ${length} exceeds hard cap ${maximumFrameBytes}`,
      );
    }
    return this.#readBody(length, progressTimeoutMs);
  }

  scrub(): void {
    this.#chunk.fill(0);
    this.#chunk = new Uint8Array();
    this.#chunkOffset = 0;
  }

  async #readLength(progressTimeoutMs?: number): Promise<number | undefined> {
    let value = 0;
    let started = false;
    for (let index = 0; index < MAX_U32_VARINT_BYTES; index += 1) {
      const byte = await this.#readByte(started ? progressTimeoutMs : undefined);
      if (byte === undefined) {
        if (index === 0) return undefined;
        throw new DelimitedChannelError('truncated_length', 'frame length is truncated');
      }
      started = true;
      const payload = byte & 0x7f;
      if (index === MAX_U32_VARINT_BYTES - 1 && (byte & 0xf0) !== 0) {
        throw new DelimitedChannelError('length_overflow', 'frame length exceeds uint32');
      }
      value += payload * (2 ** (index * 7));
      if ((byte & 0x80) === 0) {
        if (index > 0 && payload === 0) {
          throw new DelimitedChannelError(
            'non_canonical_length',
            'frame length is not minimally encoded',
          );
        }
        return value;
      }
    }
    throw new DelimitedChannelError('length_overflow', 'frame length exceeds uint32');
  }

  async #readBody(length: number, progressTimeoutMs?: number): Promise<Uint8Array> {
    const body = new Uint8Array(length);
    let written = 0;
    try {
      while (written < length) {
        if (
          this.#chunkOffset === this.#chunk.byteLength
          && !(await this.#loadChunk(progressTimeoutMs))
        ) {
          throw new DelimitedChannelError(
            'truncated_frame',
            `frame ended after ${written} of ${length} bytes`,
          );
        }
        const available = this.#chunk.byteLength - this.#chunkOffset;
        const copied = Math.min(available, length - written);
        const start = this.#chunkOffset;
        const end = start + copied;
        body.set(this.#chunk.subarray(start, end), written);
        this.#chunk.fill(0, start, end);
        this.#chunkOffset += copied;
        written += copied;
      }
      return body;
    } catch (cause) {
      body.fill(0);
      throw cause;
    }
  }

  async #readByte(progressTimeoutMs?: number): Promise<number | undefined> {
    if (
      this.#chunkOffset === this.#chunk.byteLength
      && !(await this.#loadChunk(progressTimeoutMs))
    ) {
      return undefined;
    }
    const byte = this.#chunk[this.#chunkOffset];
    this.#chunk[this.#chunkOffset] = 0;
    this.#chunkOffset += 1;
    return byte;
  }

  async #loadChunk(progressTimeoutMs?: number): Promise<boolean> {
    for (;;) {
      const operation = this.#iterator.next();
      const next = progressTimeoutMs === undefined
        ? await operation
        : await withTransportTimeout(operation, progressTimeoutMs, 'read_timeout');
      if (next.done) return false;
      if (!(next.value instanceof Uint8Array)) {
        throw new DelimitedChannelError(
          'transport_error',
          'transport emitted a non-byte chunk',
        );
      }
      if (next.value.byteLength > this.maximumTransportChunkBytes) {
        next.value.fill(0);
        throw new DelimitedChannelError(
          'transport_chunk_too_large',
          `transport chunk ${next.value.byteLength} exceeds cap ${this.maximumTransportChunkBytes}`,
        );
      }
      if (next.value.byteLength > 0) {
        this.#chunk = next.value;
        this.#chunkOffset = 0;
        return true;
      }
    }
  }
}
