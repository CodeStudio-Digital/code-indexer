import type { Readable, Writable } from 'node:stream';
import { DelimitedByteReader } from './DelimitedByteReader.js';
import { DelimitedChannelError } from './DelimitedChannelError.js';
import {
  type DelimitedByteChannelOptions,
  resolveDelimitedByteChannelOptions,
} from './DelimitedByteChannelOptions.js';
import { DelimitedFrameWriter } from './DelimitedFrameWriter.js';
import { withTransportTimeout } from './DelimitedChannelTiming.js';

export { DelimitedChannelError } from './DelimitedChannelError.js';
export type { DelimitedChannelErrorCode } from './DelimitedChannelError.js';

export type { DelimitedByteChannelOptions } from './DelimitedByteChannelOptions.js';
/**
 * One bounded, length-delimited byte channel. It can be claimed by a semantic
 * owner so retained aliases cannot bypass protocol state.
 */
export class DelimitedByteChannel {
  #maximumFrameBytes: number;
  readonly #maximumTransportChunkBytes: number;
  readonly #readTimeoutMs: number;
  readonly #writeTimeoutMs: number;
  readonly #reader: DelimitedByteReader;
  readonly #writer: DelimitedFrameWriter;
  #reading = false;
  #writing = false;
  #failure?: DelimitedChannelError;
  #owner?: object;
  #destroyed = false;

  constructor(
    private readonly readable: Readable,
    private readonly writable: Writable,
    options: DelimitedByteChannelOptions,
  ) {
    const resolved = resolveDelimitedByteChannelOptions(options);
    this.#maximumFrameBytes = resolved.maximumFrameBytes;
    this.#maximumTransportChunkBytes = resolved.maximumTransportChunkBytes;
    this.#readTimeoutMs = resolved.readTimeoutMs;
    this.#writeTimeoutMs = resolved.writeTimeoutMs;
    this.#reader = new DelimitedByteReader(
      readable,
      this.#maximumTransportChunkBytes,
    );
    this.#writer = new DelimitedFrameWriter(
      writable,
      this.#maximumTransportChunkBytes,
    );
  }

  claim(owner: object): void {
    if (this.#failure) {
      throw new DelimitedChannelError(
        'channel_failed',
        'byte channel is permanently failed',
        { cause: this.#failure },
      );
    }
    if (this.#owner && this.#owner !== owner) {
      throw this.#poison(new DelimitedChannelError(
        'channel_owned',
        'byte channel already has an owner',
      ));
    }
    this.#owner = owner;
  }

  async receive(owner?: object): Promise<Uint8Array | undefined> {
    this.#assertUsable(owner);
    if (this.#reading) {
      throw this.#poison(new DelimitedChannelError(
        'concurrent_read',
        'only one receive may be active',
      ));
    }
    this.#reading = true;
    try {
      return await withTransportTimeout(
        this.#reader.receive(this.#maximumFrameBytes),
        this.#readTimeoutMs,
        'read_timeout',
      );
    } catch (cause) {
      throw this.#poison(cause);
    } finally {
      this.#reading = false;
    }
  }

  /** Keeps an authenticated permanent channel idle without disabling the
   * bounded progress timeout once a frame starts arriving. */
  async receiveAfterIdle(owner?: object): Promise<Uint8Array | undefined> {
    this.#assertUsable(owner);
    if (this.#reading) {
      throw this.#poison(new DelimitedChannelError(
        'concurrent_read',
        'only one receive may be active',
      ));
    }
    this.#reading = true;
    try {
      return await this.#reader.receiveAfterIdle(
        this.#maximumFrameBytes,
        this.#readTimeoutMs,
      );
    } catch (cause) {
      throw this.#poison(cause);
    } finally {
      this.#reading = false;
    }
  }

  async send(frame: Uint8Array, owner?: object): Promise<void> {
    this.#assertUsable(owner);
    if (this.#writing) {
      throw this.#poison(new DelimitedChannelError(
        'concurrent_write',
        'only one send may be active',
      ));
    }
    if (frame.byteLength === 0) {
      throw this.#poison(new DelimitedChannelError(
        'empty_frame',
        'zero-length frame is forbidden',
      ));
    }
    if (frame.byteLength > this.#maximumFrameBytes) {
      throw this.#poison(new DelimitedChannelError(
        'frame_too_large',
        `frame length ${frame.byteLength} exceeds hard cap ${this.#maximumFrameBytes}`,
      ));
    }
    this.#writing = true;
    try {
      await this.#writer.write(frame, this.#writeTimeoutMs);
    } catch (cause) {
      throw this.#poison(cause);
    } finally {
      this.#writing = false;
    }
  }

  narrowMaximumFrameBytes(maximum: number, owner?: object): void {
    this.#assertUsable(owner);
    try {
      assertPositiveUint32(maximum, 'maximumFrameBytes');
    } catch (cause) {
      throw this.#poison(cause);
    }
    if (maximum > this.#maximumFrameBytes) {
      throw this.#poison(new DelimitedChannelError(
        'invalid_limit',
        'frame maximum can only be narrowed',
      ));
    }
    this.#maximumFrameBytes = maximum;
  }

  fail(cause: unknown, owner?: object): void {
    this.#assertOwner(owner);
    this.#poison(cause);
  }

  get maximumFrameBytes(): number {
    return this.#maximumFrameBytes;
  }

  get maximumTransportChunkBytes(): number {
    return this.#maximumTransportChunkBytes;
  }

  get readTimeoutMs(): number {
    return this.#readTimeoutMs;
  }

  get writeTimeoutMs(): number {
    return this.#writeTimeoutMs;
  }

  get isFailed(): boolean {
    return this.#failure !== undefined;
  }

  #assertUsable(owner?: object): void {
    if (this.#failure) {
      throw new DelimitedChannelError(
        'channel_failed',
        'byte channel is permanently failed',
        { cause: this.#failure },
      );
    }
    this.#assertOwner(owner);
  }

  #assertOwner(owner?: object): void {
    if (this.#owner && this.#owner !== owner) {
      throw this.#poison(new DelimitedChannelError(
        'channel_owned',
        'byte channel is owned by a protocol channel',
      ));
    }
  }

  #poison(cause: unknown): DelimitedChannelError {
    if (this.#failure) return this.#failure;
    const failure = cause instanceof DelimitedChannelError
      ? cause
      : new DelimitedChannelError(
        'transport_error',
        'byte channel transport failed',
        { cause },
      );
    this.#failure = failure;
    this.#reader.scrub();
    this.#writer.abort(failure);
    this.#destroyEndpoints();
    return failure;
  }

  #destroyEndpoints(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    const endpoints = new Set<Readable | Writable>([
      this.readable,
      this.writable,
    ]);
    for (const endpoint of endpoints) {
      try {
        endpoint.destroy();
      } catch {
        // Protocol failure is already retained; teardown remains best-effort.
      }
    }
  }
}

function assertPositiveUint32(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0 || value > 0xffff_ffff) {
    throw new DelimitedChannelError('invalid_limit', `${field} must be a positive uint32`);
  }
}
